// tslint:disable

import { isError, isErrorEvent } from '@sentry/utils/is';
import { getGlobalObject } from '@sentry/utils/misc';

export interface StackFrame {
  url: string;
  func: string;
  args: string[];
  line: number;
  column: number;
  context: string[];
}

export interface StackTrace {
  mode: string;
  mechanism: string;
  name: string;
  message: string;
  url: string;
  stack: StackFrame[];
  useragent: string;
  original?: string;
}

interface ComputeStackTrace {
  (ex: Error, depth?: string | number): StackTrace;
}

var window = getGlobalObject() as Window;

interface TraceKit {
  report: any;
  collectWindowErrors: any;
  computeStackTrace: any;
  linesOfContext: any;
}

var TraceKit: TraceKit = {
  report: false,
  collectWindowErrors: false,
  computeStackTrace: false,
  linesOfContext: false,
};

var UNKNOWN_FUNCTION = '?';
var ERROR_TYPES_RE = /^(?:[Uu]ncaught (?:exception: )?)?(?:((?:Eval|Internal|Range|Reference|Syntax|Type|URI|)Error): )?(.*)$/;

function _has(object: any, key: any) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function getLocationHref() {
  if (typeof document === 'undefined' || document.location == null) return '';
  return document.location.href;
}
TraceKit.report = (function reportModuleWrapper() {
  var handlers: any = [],
    lastException: any = null,
    lastExceptionStack: any = null;

  function subscribe(handler: any) {
    handlers.push(handler);
  }

  function notifyHandlers(stack: any, isWindowError: any, error: any) {
    var exception = null;
    if (isWindowError && !TraceKit.collectWindowErrors) {
      return;
    }
    for (var i in handlers) {
      if (_has(handlers, i)) {
        try {
          handlers[i](stack, isWindowError, error);
        } catch (inner) {
          exception = inner;
        }
      }
    }

    if (exception) {
      throw exception;
    }
  }

  var _oldOnerrorHandler: any, _onErrorHandlerInstalled: any;

  function traceKitWindowOnError(message: any, url: any, lineNo: any, columnNo: any, errorObj: any) {
    var stack = null;
    errorObj = isErrorEvent(errorObj) ? errorObj.error : errorObj;
    message = isErrorEvent(message) ? message.message : message;

    if (lastExceptionStack) {
      TraceKit.computeStackTrace.augmentStackTraceWithInitialElement(lastExceptionStack, url, lineNo, message);
      processLastException();
    } else if (errorObj && isError(errorObj)) {
      stack = TraceKit.computeStackTrace(errorObj);
      stack.mechanism = 'onerror';
      notifyHandlers(stack, true, errorObj);
    } else {
      var location: any = {
        url: url,
        line: lineNo,
        column: columnNo,
      };

      var name;
      var msg = message;
      if ({}.toString.call(message) === '[object String]') {
        var groups = message.match(ERROR_TYPES_RE);
        if (groups) {
          name = groups[1];
          msg = groups[2];
        }
      }

      location.func = UNKNOWN_FUNCTION;
      location.context = null;
      stack = {
        name: name,
        message: msg,
        mode: 'onerror',
        mechanism: 'onerror',
        stack: [
          {
            ...location,
            url: location.url || getLocationHref(),
          },
        ],
      };

      notifyHandlers(stack, true, null);
    }

    if (_oldOnerrorHandler) {
      // @ts-ignore
      return _oldOnerrorHandler.apply(this, arguments);
    }

    return false;
  }

  function traceKitWindowOnUnhandledRejection(e: any) {
    var err = (e && (e.detail ? e.detail.reason : e.reason)) || e;
    var stack = TraceKit.computeStackTrace(err);
    stack.mechanism = 'onunhandledrejection';
    notifyHandlers(stack, true, err);
  }

  function installGlobalHandler() {
    if (_onErrorHandlerInstalled === true) {
      return;
    }

    _oldOnerrorHandler = window.onerror;
    window.onerror = traceKitWindowOnError;
    _onErrorHandlerInstalled = true;
  }

  function installGlobalUnhandledRejectionHandler() {
    (window as any).onunhandledrejection = traceKitWindowOnUnhandledRejection;
  }

  function processLastException() {
    var _lastExceptionStack = lastExceptionStack,
      _lastException = lastException;
    lastExceptionStack = null;
    lastException = null;
    notifyHandlers(_lastExceptionStack, false, _lastException);
  }

  function report(ex: any) {
    if (lastExceptionStack) {
      if (lastException === ex) {
        return;
      } else {
        processLastException();
      }
    }

    var stack = TraceKit.computeStackTrace(ex);
    lastExceptionStack = stack;
    lastException = ex;

    setTimeout(
      function() {
        if (lastException === ex) {
          processLastException();
        }
      },
      stack.incomplete ? 2000 : 0,
    );

    throw ex;
  }

  (report as any).subscribe = subscribe;
  (report as any).installGlobalHandler = installGlobalHandler;
  (report as any).installGlobalUnhandledRejectionHandler = installGlobalUnhandledRejectionHandler;

  return report;
})();

TraceKit.computeStackTrace = (function computeStackTraceWrapper() {
  function computeStackTraceFromStackProp(ex: any) {
    if (!ex.stack) {
      return null;
    }

    var chrome = /^\s*at (?:(.*?) ?\()?((?:file|https?|blob|chrome-extension|native|eval|webpack|<anonymous>|[a-z]:|\/).*?)(?::(\d+))?(?::(\d+))?\)?\s*$/i,
      gecko = /^\s*(.*?)(?:\((.*?)\))?(?:^|@)((?:file|https?|blob|chrome|webpack|resource|moz-extension).*?:\/.*?|\[native code\]|[^@]*bundle)(?::(\d+))?(?::(\d+))?\s*$/i,
      winjs = /^\s*at (?:((?:\[object object\])?.+) )?\(?((?:file|ms-appx|https?|webpack|blob):.*?):(\d+)(?::(\d+))?\)?\s*$/i,
      isEval,
      geckoEval = /(\S+) line (\d+)(?: > eval line \d+)* > eval/i,
      chromeEval = /\((\S*)(?::(\d+))(?::(\d+))\)/,
      lines = ex.stack.split('\n'),
      stack = [],
      submatch,
      parts,
      element,
      reference = /^(.*) is undefined$/.exec(ex.message);

    for (var i = 0, j = lines.length; i < j; ++i) {
      if ((parts = chrome.exec(lines[i]))) {
        var isNative = parts[2] && parts[2].indexOf('native') === 0;
        isEval = parts[2] && parts[2].indexOf('eval') === 0;
        if (isEval && (submatch = chromeEval.exec(parts[2]))) {
          parts[2] = submatch[1];
        }
        element = {
          url: !isNative ? parts[2] : null,
          func: parts[1] || UNKNOWN_FUNCTION,
          args: isNative ? [parts[2]] : [],
          line: parts[3] ? +parts[3] : null,
          column: parts[4] ? +parts[4] : null,
        };
      } else if ((parts = winjs.exec(lines[i]))) {
        element = {
          url: parts[2],
          func: parts[1] || UNKNOWN_FUNCTION,
          args: [],
          line: +parts[3],
          column: parts[4] ? +parts[4] : null,
        };
      } else if ((parts = gecko.exec(lines[i]))) {
        isEval = parts[3] && parts[3].indexOf(' > eval') > -1;
        if (isEval && (submatch = geckoEval.exec(parts[3]))) {
          parts[3] = submatch[1];
        } else if (i === 0 && !parts[5] && ex.columnNumber !== void 0) {
          stack[0].column = ex.columnNumber + 1;
        }
        element = {
          url: parts[3],
          func: parts[1] || UNKNOWN_FUNCTION,
          args: parts[2] ? parts[2].split(',') : [],
          line: parts[4] ? +parts[4] : null,
          column: parts[5] ? +parts[5] : null,
        };
      } else {
        continue;
      }

      if (!element.func && element.line) {
        element.func = UNKNOWN_FUNCTION;
      }

      (element as any).context = null;

      stack.push(element);
    }

    if (!stack.length) {
      return null;
    }

    if (stack[0] && stack[0].line && !stack[0].column && reference) {
      stack[0].column = null;
    }

    return {
      mode: 'stack',
      name: ex.name,
      message: ex.message,
      stack: stack,
    };
  }

  function computeStackTraceFromStacktraceProp(ex: any) {
    var stacktrace = ex.stacktrace;
    if (!stacktrace) {
      return;
    }

    var opera10Regex = / line (\d+).*script (?:in )?(\S+)(?:: in function (\S+))?$/i,
      opera11Regex = / line (\d+), column (\d+)\s*(?:in (?:<anonymous function: ([^>]+)>|([^\)]+))\((.*)\))? in (.*):\s*$/i,
      lines = stacktrace.split('\n'),
      stack = [],
      parts;

    for (var line = 0; line < lines.length; line += 2) {
      var element = null;
      if ((parts = opera10Regex.exec(lines[line]))) {
        element = {
          url: parts[2],
          line: +parts[1],
          column: null,
          func: parts[3],
          args: [],
        };
      } else if ((parts = opera11Regex.exec(lines[line]))) {
        element = {
          url: parts[6],
          line: +parts[1],
          column: +parts[2],
          func: parts[3] || parts[4],
          args: parts[5] ? parts[5].split(',') : [],
        };
      }

      if (element) {
        if (!element.func && element.line) {
          element.func = UNKNOWN_FUNCTION;
        }
        if (element.line) {
          (element as any).context = null;
        }

        if (!(element as any).context) {
          (element as any).context = [lines[line + 1]];
        }

        stack.push(element);
      }
    }

    if (!stack.length) {
      return null;
    }

    return {
      mode: 'stacktrace',
      name: ex.name,
      message: ex.message,
      stack: stack,
    };
  }

  function computeStackTraceFromOperaMultiLineMessage(ex: any) {
    var lines = ex.message.split('\n');
    if (lines.length < 4) {
      return null;
    }

    var lineRE1 = /^\s*Line (\d+) of linked script ((?:file|https?|blob)\S+)(?:: in function (\S+))?\s*$/i,
      lineRE2 = /^\s*Line (\d+) of inline#(\d+) script in ((?:file|https?|blob)\S+)(?:: in function (\S+))?\s*$/i,
      lineRE3 = /^\s*Line (\d+) of function script\s*$/i,
      stack = [],
      scripts = window && window.document && window.document.getElementsByTagName('script'),
      inlineScriptBlocks = [],
      parts;

    for (var s in scripts) {
      if (_has(scripts, s) && !scripts[s].src) {
        inlineScriptBlocks.push(scripts[s]);
      }
    }

    for (var line = 2; line < lines.length; line += 2) {
      var item = null;
      if ((parts = lineRE1.exec(lines[line]))) {
        item = {
          url: parts[2],
          func: parts[3],
          args: [],
          line: +parts[1],
          column: null,
        };
      } else if ((parts = lineRE2.exec(lines[line]))) {
        item = {
          url: parts[3],
          func: parts[4],
          args: [],
          line: +parts[1],
          column: null,
        };
      } else if ((parts = lineRE3.exec(lines[line]))) {
        var url = getLocationHref().replace(/#.*$/, '');
        item = {
          url: url,
          func: '',
          args: [],
          line: parts[1],
          column: null,
        };
      }

      if (item) {
        if (!item.func) {
          item.func = UNKNOWN_FUNCTION;
        }
        (item as any).context = [lines[line + 1]];
        stack.push(item);
      }
    }
    if (!stack.length) {
      return null;
    }

    return {
      mode: 'multiline',
      name: ex.name,
      message: lines[0],
      stack: stack,
    };
  }

  function augmentStackTraceWithInitialElement(stackInfo: any, url: any, lineNo: any, message: any) {
    var initial = {
      url: url,
      line: lineNo,
    };

    if (initial.url && initial.line) {
      stackInfo.incomplete = false;

      if (!(initial as any).func) {
        (initial as any).func = UNKNOWN_FUNCTION;
      }

      if (!(initial as any).context) {
        (initial as any).context = null;
      }

      var reference = / '([^']+)' /.exec(message);
      if (reference) {
        (initial as any).column = null;
      }

      if (stackInfo.stack.length > 0) {
        if (stackInfo.stack[0].url === initial.url) {
          if (stackInfo.stack[0].line === initial.line) {
            return false;
          } else if (!stackInfo.stack[0].line && stackInfo.stack[0].func === (initial as any).func) {
            stackInfo.stack[0].line = initial.line;
            stackInfo.stack[0].context = (initial as any).context;
            return false;
          }
        }
      }

      stackInfo.stack.unshift(initial);
      stackInfo.partial = true;
      return true;
    } else {
      stackInfo.incomplete = true;
    }

    return false;
  }

  function computeStackTraceByWalkingCallerChain(ex: any, depth: any) {
    var functionName = /function\s+([_$a-zA-Z\xA0-\uFFFF][_$a-zA-Z0-9\xA0-\uFFFF]*)?\s*\(/i,
      stack = [],
      funcs = {},
      recursion = false,
      parts,
      item;

    for (var curr = computeStackTraceByWalkingCallerChain.caller; curr && !recursion; curr = curr.caller) {
      if (curr === computeStackTrace || curr === TraceKit.report) {
        continue;
      }

      item = {
        url: null,
        func: UNKNOWN_FUNCTION,
        args: [],
        line: null,
        column: null,
      };

      if (curr.name) {
        item.func = curr.name;
      } else if ((parts = functionName.exec(curr.toString()))) {
        item.func = parts[1];
      }

      if (typeof item.func === 'undefined') {
        try {
          item.func = (parts as any).input.substring(0, (parts as any).input.indexOf('{'));
        } catch (e) {}
      }

      if ((funcs as any)['' + curr]) {
        recursion = true;
      } else {
        (funcs as any)['' + curr] = true;
      }

      stack.push(item);
    }

    if (depth) {
      stack.splice(0, depth);
    }

    var result = {
      mode: 'callers',
      name: ex.name,
      message: ex.message,
      stack: stack,
    };
    augmentStackTraceWithInitialElement(
      result,
      ex.sourceURL || ex.fileName,
      ex.line || ex.lineNumber,
      ex.message || ex.description,
    );
    return result;
  }

  function computeStackTrace(ex: any, depth: any) {
    var stack = null;
    depth = depth == null ? 0 : +depth;

    try {
      stack = computeStackTraceFromStacktraceProp(ex);
      if (stack) {
        return stack;
      }
    } catch (e) {}

    try {
      stack = computeStackTraceFromStackProp(ex);
      if (stack) {
        return stack;
      }
    } catch (e) {}

    try {
      stack = computeStackTraceFromOperaMultiLineMessage(ex);
      if (stack) {
        return stack;
      }
    } catch (e) {}

    try {
      stack = computeStackTraceByWalkingCallerChain(ex, depth + 1);
      if (stack) {
        return stack;
      }
    } catch (e) {}

    return {
      original: ex,
      name: ex.name,
      message: ex.message,
      mode: 'failed',
    };
  }

  (computeStackTrace as any).augmentStackTraceWithInitialElement = augmentStackTraceWithInitialElement;
  (computeStackTrace as any).computeStackTraceFromStackProp = computeStackTraceFromStackProp;

  return computeStackTrace;
})();

TraceKit.collectWindowErrors = true;
TraceKit.linesOfContext = 11;

const subscribe = TraceKit.report.subscribe;
const installGlobalHandler = TraceKit.report.installGlobalHandler;
const installGlobalUnhandledRejectionHandler = TraceKit.report.installGlobalUnhandledRejectionHandler;
const computeStackTrace: ComputeStackTrace = TraceKit.computeStackTrace;

export { subscribe, installGlobalHandler, installGlobalUnhandledRejectionHandler, computeStackTrace };

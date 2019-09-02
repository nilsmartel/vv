import { app } from 'electron';

import { spawn } from 'child_process';
import path from 'path';

import { createDecodeStream } from 'msgpack-lite/lib/decode-stream';
import { createEncodeStream } from 'msgpack-lite/lib/encode-stream';
import { encode } from 'msgpack-lite';

import debounce from 'lodash/debounce';

import shellEnv from '../../lib/shellEnv';
import nvimCommand from '../../lib/nvimCommand';
import isDev from '../../lib/isDev';

const vvSourceCommand = () =>
  `source ${path.join(app.getAppPath(), isDev('./', '../'), 'bin/vv.vim')}`;

const startNvimProcess = ({ args, cwd }) => {
  const env = shellEnv();

  const nvimArgs = ['--embed', '--cmd', vvSourceCommand(), ...args];

  const nvimProcess = spawn(nvimCommand(env), nvimArgs, { cwd, env });

  // Pipe errors to std output and also send it in console as error.
  let errorStr = '';
  nvimProcess.stderr.pipe(process.stdout);
  nvimProcess.stderr.on('data', data => {
    errorStr += data.toString();
    debounce(() => {
      if (errorStr) console.error(errorStr); // eslint-disable-line no-console
      errorStr = '';
    }, 10)();
  });

  // nvimProcess.stdout.on('data', (data) => {
  //   console.log(data.toString());
  // });

  return nvimProcess;
};

const api = ({ args, cwd }) => {
  let proc;
  let msgpackIn;
  let msgpackOut;

  let requestId = 0;
  const requestPromises = {};

  let subscriptions = [];

  const send = (customId, command, ...params) => {
    if (!msgpackOut) {
      throw new Error('Neovim is not initialized');
    }
    let id = customId;
    if (!id) {
      requestId += 1;
      id = requestId * 2; // Request id for main is always even
    }
    msgpackOut.write(encode([0, id, `nvim_${command}`, params]));
    return new Promise((resolve, reject) => {
      requestPromises[id] = {
        resolve,
        reject,
      };
    });
  };

  const commandFactory = name => (...params) => send(null, name, ...params);

  const nvim = {
    eval: commandFactory('eval'),
    callFunction: commandFactory('call_function'),
    command: commandFactory('command'),
    input: commandFactory('input'),
    getMode: commandFactory('get_mode'),
    uiTryResize: commandFactory('ui_try_resize'),
    uiAttach: commandFactory('ui_attach'),
    subscribe: commandFactory('subscribe'),
    getHlByName: commandFactory('get_hl_by_name'),
  };

  // Fetch current mode from nvim, leaves only first letter to match groups of modes.
  // https://neovim.io/doc/user/eval.html#mode()
  nvim.getShortMode = async () => {
    const { mode } = await nvim.getMode();
    return mode.replace('CTRL-', '')[0];
  };

  const on = (method, callback) => {
    if (method === 'disconnect') {
      proc.on('close', callback);
    } else if (method === 'data') {
      msgpackIn.on('data', callback);
    } else {
      nvim.subscribe(method);
      subscriptions.push([method, callback]);
    }
  };

  const off = (method, callback) => {
    subscriptions = subscriptions.filter(([m, c]) => !(method === m && callback === c));
  };

  proc = startNvimProcess({ args, cwd });

  const decodeStream = createDecodeStream();
  const encodeStream = createEncodeStream();

  msgpackIn = proc.stdout.pipe(decodeStream);
  msgpackOut = encodeStream.pipe(proc.stdin);

  // https://github.com/msgpack-rpc/msgpack-rpc/blob/master/spec.md
  msgpackIn.on('data', ([type, ...rest]) => {
    if (type === 1) {
      // Receive response for previous request with id
      const [id, error, result] = rest;
      if (requestPromises[id]) {
        if (error) {
          requestPromises[id].reject(error);
        } else {
          requestPromises[id].resolve(result);
        }
        requestPromises[id] = null;
      }
    } else if (type === 2) {
      // Receive notification
      const [method, params] = rest;
      subscriptions.forEach(([m, c]) => {
        if (m === method) {
          c(params);
        }
      });
    }
  });

  // Source vv specific ext on -u NONE
  const uFlagIndex = args.indexOf('-u');
  if (uFlagIndex !== -1 && args[uFlagIndex + 1] === 'NONE') {
    nvim.command(vvSourceCommand());
  }

  return {
    on,
    off,
    send,
    ...nvim,
  };
};

export default api;

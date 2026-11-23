// Verification processes only. Never preload this into the user's normal app.
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const input = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = input && typeof input === 'object' ? input : null;
  const host = options ? options.host : typeof args[1] === 'string' ? args[1] : undefined;
  if (options?.path || (host && !['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)))
    throw new Error('Verification forbids external network connections');
  return Reflect.apply(connect, this, args);
};
syncBuiltinESMExports();

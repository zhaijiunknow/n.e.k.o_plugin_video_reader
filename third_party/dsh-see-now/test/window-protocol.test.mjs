import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptWindowProtocol, windowAlive, windowStatus } from '../src/window.js';

test('协议状态区分 ready、closed 和非法报文', () => {
  const record = { state: 'starting', reason: null, exited: false, ready() {} };
  acceptWindowProtocol(record, '{"version":1,"state":"ready"}');
  assert.equal(record.state, 'ready');
  acceptWindowProtocol(record, 'not-json');
  acceptWindowProtocol(record, '{"version":2,"state":"closed"}');
  assert.equal(record.state, 'ready');
  acceptWindowProtocol(record, '{"version":1,"state":"closed","reason":"user"}');
  assert.deepEqual({ state: record.state, reason: record.reason }, { state: 'closed', reason: 'user' });
  assert.equal(windowStatus(), null);
  assert.equal(typeof windowAlive(), 'boolean');
});

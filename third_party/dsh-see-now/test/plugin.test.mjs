import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TOOLS_PATH = process.env.DSH_TOOLS_PATH
  ?? join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');

/**
 * 假上下文。**`saveImage` 故意读 `this.compression`** —— 真事故就是它：
 * 方法从服务上取下来裸调会丢 this，报 `Cannot read properties of undefined`，
 * 所有出图工具一起挂。这里让裸调直接炸，`.call()` 才对。
 */
function fakeCtx() {
  const registered = [];
  const disposed = [];
  const warns = [];
  const saved = [];
  const ctx = {
    tools: {
      register(tool) {
        registered.push(tool);
        return () => disposed.push(tool.name);
      },
    },
    logger: { warn: (m) => warns.push(m), error: (m) => warns.push(m), info: () => {} },
    attachments: {
      compression: 'png',
      async saveImage(o) {
        assert.equal(this.compression, 'png', 'saveImage 必须用 .call(svc) 调，否则 this 丢了');
        saved.push(o);
        return { attachmentId: `fake-${saved.length}`, mediaType: o.mediaType, bytes: o.data.length };
      },
    },
  };
  return { ctx, registered, disposed, warns, saved };
}

const skip = !existsSync(TOOLS_PATH) && '找不到宿主的 dsh-tools，跳过（设 DSH_TOOLS_PATH 可指定）';

test('插件能加载、注册一个工具、dispose 能解绑', { skip }, async () => {
  process.env.DSH_TOOLS_PATH = TOOLS_PATH;
  const mod = await import('../src/index.js');
  assert.equal(mod.name, 'dsh-see-now');
  assert.deepEqual(mod.inject, ['tools', 'attachments', 'sessionController']);

  const { ctx, registered, disposed } = fakeCtx();
  const dispose = await mod.apply(ctx);

  assert.equal(registered.length, 1, '只注册一个工具');
  assert.equal(registered[0].name, 'see_now');
  assert.equal(typeof registered[0].execute, 'function');

  dispose();
  assert.ok(disposed.includes('see_now'), '工具要解绑');
});

test('刚起来时 status 说没在采集，不抛错', { skip }, async () => {
  process.env.DSH_TOOLS_PATH = TOOLS_PATH;
  const mod = await import('../src/index.js');
  const { ctx, registered } = fakeCtx();
  await mod.apply(ctx);
  const v = await registered[0].execute({ action: 'status' });
  assert.match(v.text, /没在采集/);
});

test('未知 action 列可用项，而不是静默什么都不做', { skip }, async () => {
  process.env.DSH_TOOLS_PATH = TOOLS_PATH;
  const mod = await import('../src/index.js');
  const { ctx, registered } = fakeCtx();
  await mod.apply(ctx);
  const v = await registered[0].execute({ action: 'dance' });
  assert.match(v.text, /未知 action/);
  assert.match(v.text, /watch/);
});

test('action:"help" 给手册，且不启动采集（它是常驻文案瘦身的那一半）', { skip }, async () => {
  process.env.DSH_TOOLS_PATH = TOOLS_PATH;
  const mod = await import('../src/index.js');
  const { ctx, registered, saved } = fakeCtx();
  await mod.apply(ctx);
  const v = await registered[0].execute({ action: 'help' });
  // 契约里删掉的那些"为什么/多少 token"必须在这里找得到，否则就是真丢了
  assert.match(v.text, /手册/);
  assert.match(v.text, /pace/);
  assert.match(v.text, /变化日志/);
  assert.equal(saved.length, 0, 'help 不能提交图片');
  assert.doesNotMatch(v.text, /没在采集/, 'help 不该去碰采集状态');
});

/** 递归找出 undefined / 非有限数 —— 宿主就是拿这个判 "not lossless JSON" 的 */
function badJson(v, path = '$') {
  if (v === undefined) return `${path} is undefined`;
  if (typeof v === 'number' && !Number.isFinite(v)) return `${path} = ${v}`;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i += 1) {
      const r = badJson(v[i], `${path}[${i}]`);
      if (r) return r;
    }
    return null;
  }
  if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) {
      const r = badJson(val, `${path}.${k}`);
      if (r) return r;
    }
  }
  return null;
}

test('返回值必须是无损 JSON —— undefined 会让整个工具调用作废', { skip }, async () => {
  process.env.DSH_TOOLS_PATH = TOOLS_PATH;
  const mod = await import('../src/index.js');
  const { ctx, registered } = fakeCtx();
  await mod.apply(ctx);
  for (const args of [{ action: 'status' }, { action: 'nope' }, { action: 'stop' }]) {
    const v = await registered[0].execute(args);
    const bad = badJson(v);
    assert.equal(bad, null, `action=${args.action} 的返回值里有非法 JSON: ${bad}`);
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(v)));
  }
});

test('peek：没在采集时说得清，不假装给了图', { skip }, async () => {
  process.env.DSH_TOOLS_PATH = TOOLS_PATH;
  const mod = await import('../src/index.js');
  const { ctx, registered, saved } = fakeCtx();
  await mod.apply(ctx);
  const v = await registered[0].execute({ action: 'peek' });
  assert.equal(saved.length, 0, '没图就不该提交附件');
  assert.match(v.text, /没有画面/);
});

/**
 * define-tool.test.mjs — 内置 `defineTool` 兜底的行为。
 *
 * 为什么必须测：宿主的 `@deepseek-ai/dsh-tools` 在 `app.asar` 里，插件常常 import 不到
 * （社区实报：装完插件一个工具都不出现）。兜底版要是转错了 schema，
 * 表现是"参数被宿主吞掉"——**不报错**，只是安静地退回默认值，比装不上还难查。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { defineToolCompat } from '../src/define-tool.js';
import { seeNowToolSpec, TOOL_NAME } from '../src/tool-spec.js';

// ---- author spec 的编译规则（照抄宿主 runSchemaCompiler 的语义）----

test('type:"json" 退化成注解，不产生 type:"json"', () => {
  const tool = defineToolCompat({
    name: 't', description: 'd', parameters: {},
    output: {
      schema: { type: 'object', properties: { meta: { type: 'json', description: '任意' } }, additionalProperties: false },
      render: () => '',
    },
    execute: () => ({}),
  });
  const s = JSON.stringify(tool.output.schema);
  assert.equal(s.includes('"json"'), false, '类型 json 必须被剥掉');
  assert.equal(tool.output.schema.properties.meta.description, '任意', '注解要保留');
});

test('required:true 提升到父级 required，并从属性里删掉', () => {
  const tool = defineToolCompat({
    name: 't', description: 'd', parameters: { a: { type: 'string', required: true }, b: { type: 'string' } },
    output: { schema: {}, render: () => '' },
    execute: () => ({}),
  });
  assert.deepEqual(tool.parameters.required, ['a']);
  assert.equal(tool.parameters.properties.a.required, undefined);
  assert.equal(tool.parameters.required.includes('b'), false);
});

test('没写 required:true 的参数一律可选（宿主的默认就是个空 required）', () => {
  const tool = defineToolCompat({
    name: 't', description: 'd', parameters: { a: { type: 'string' }, b: { type: 'number' } },
    output: { schema: {}, render: () => '' },
    execute: () => ({}),
  });
  assert.equal(tool.parameters.required, undefined);
});

test('缺 output.render / execute 要立刻抛（别到注册时才发现）', () => {
  assert.throws(() => defineToolCompat({ name: 't', description: 'd', parameters: {}, output: {}, execute: () => ({}) }), /output\.render/);
  assert.throws(() => defineToolCompat({ name: 't', description: 'd', parameters: {}, output: { render: () => '' } }), /execute/);
});

test('execute 原样转发（兜底版不吞参数、不改返回值）', async () => {
  const tool = defineToolCompat({
    name: 't', description: 'd', parameters: {},
    output: { schema: {}, render: () => '' },
    execute: async (args) => ({ got: args }),
  });
  assert.deepEqual(await tool.execute({ x: 1 }, {}), { got: { x: 1 } });
});

test('真实工具 spec 能编译通过（这是社区那个"装完没工具"的复现点）', () => {
  // 真实注册时 execute 是后拼上去的（见 src/index.js 的 toolObj），spec 本身不带
  const tool = defineToolCompat({ ...seeNowToolSpec(), execute: async () => ({}) });
  assert.equal(tool.name, TOOL_NAME);
  assert.equal(tool.parameters.type, 'object');
  assert.ok(Object.keys(tool.parameters.properties).length > 0);
  assert.equal(typeof tool.output.render, 'function');
  assert.ok(tool.output.schema, 'output.schema 必须有');
  // 真实 spec 没写 required:true → 不该冒出 required
  assert.equal(tool.parameters.required, undefined);
  // 宿主 register() 认的输出形状
  assert.equal(typeof tool.output.schema, 'object');
});

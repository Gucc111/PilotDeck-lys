import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/notifications.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const mod = { exports: {} };
new Function('module', 'exports', compiled)(mod, mod.exports);
const { createDesktopNotifications, badgeBitmap, nativeNotificationOptions } = mod.exports;
const payload = { id: 'r1', title: 'Report', body: 'Task completed · Click to view\nPreview', silent: false, data: { scope: '1', sessionId: 's1', eventId: 'r1', kind: 'completed' } };
function setup(platform = 'darwin') {
  const state = { created: [], badges: [], overlays: [], navigation: [], saved: null };
  const controller = createDesktopNotifications({
    platform, supported: () => true, read: () => ({ enabled: true }), save: value => { state.saved = value; },
    create: value => { const item = Object.assign(new EventEmitter(), { payload: value, shown: false, show() { this.shown = true; }, close() { this.emit('close'); } }); state.created.push(item); return item; },
    setBadge: count => state.badges.push(count), setOverlay: (bitmap, label) => state.overlays.push({ bitmap, label }),
    navigate: async data => { state.navigation.push(data); }, report: error => { throw error; },
  });
  return { controller, state };
}
test('deduplicates native notifications and restores the exact conversation on click', async () => {
  const { controller, state } = setup();
  assert.equal(controller.show(payload), true);
  assert.equal(controller.show(payload), false);
  assert.equal(state.created.length, 1);
  assert.equal(state.created[0].shown, true);
  state.created[0].emit('click');
  assert.deepEqual(state.navigation, [payload.data]);
  controller.show({ ...payload, id: 'r2' });
  assert.equal(state.created[1].payload.silent, true, 'nearby tasks must not stack sounds');
});
for (const platform of ['darwin', 'win32', 'linux']) test(`${platform}: hides zero badges and applies the independent badge preference`, () => {
  const { controller, state } = setup(platform);
  controller.badge(5);
  controller.preferences({ enabled: false, badge: false });
  assert.equal(controller.show(payload), false);
  if (platform === 'win32') {
    assert.ok(state.overlays[0].bitmap.length === 32 * 32 * 4);
    assert.match(state.overlays[0].label, /5/);
    assert.equal(state.overlays.at(-1).bitmap, null);
  } else assert.deepEqual(state.badges, [5, 0]);
});
test('supports silent notifications and enforces preview privacy in the main process', () => {
  const { controller, state } = setup();
  controller.preferences({ enabled: true, sound: false, preview: false });
  controller.show(payload);
  assert.equal(state.created[0].payload.silent, true);
  assert.equal(state.created[0].payload.body.includes('Preview'), false);
  assert.equal(controller.status().permission, 'unknown', 'support must not be presented as OS permission');
  assert.throws(() => controller.show({ ...payload, data: { sessionId: '' } }), /Invalid notification/);
  assert.equal(badgeBitmap(123).length, 4096);
});

for (const platform of ['darwin', 'win32', 'linux']) test(`${platform}: relies on OS application identity without an extra notification image`, () => {
  const options = nativeNotificationOptions(platform, payload);
  assert.equal(options.title, payload.title);
  assert.equal(options.body, payload.body);
  assert.equal('icon' in options, false);
  assert.equal('toastXml' in options, false, 'the default Windows template must not add another image');
  assert.equal(options.silent, payload.silent);
  assert.equal(options.urgency, platform === 'linux' ? 'normal' : undefined);
});

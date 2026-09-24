import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const demo = process.env.TACTICLAB_TEST_DEMO || 'D:/5EDemocache/g161-20260827215952884877980_de_dust2.dem';
await fs.access(demo);
const root = path.resolve('projects');
const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tacticlab-ui-userdata-'));
await fs.mkdir(root, { recursive: true });
await fs.mkdir('artifacts', { recursive: true });
const before = new Set(await fs.readdir(root));
const env = { ...process.env, TACTICLAB_TEST_USER_DATA: userDataDir };
delete env.ELECTRON_RUN_AS_NODE;
const ffmpeg = path.resolve('tools/ffmpeg/ffmpeg.exe');
const errors = [];
let projectDir = '';
let fixtureDir = '';
let app;
let page;

async function launch() {
  const instance = await electron.launch({ args: ['.'], env });
  const page = await instance.firstWindow();
  page.on('pageerror', error => errors.push(String(error)));
  await page.waitForLoadState('domcontentloaded');
  await page.locator('.language-switcher select').waitFor();
  await page.evaluate(async () => window.desktop.setLanguage('en-US'));
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.getByRole('button', { name: 'Open Demo' }).waitFor();
  return { instance, page };
}
async function stubPicker(instance, file) {
  await instance.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
  }, file);
}
async function openProject(instance, page, file) {
  await stubPicker(instance, file);
  await page.getByRole('button', { name: 'Open Project', exact: true }).first().click();
  await page.locator('.pov-tile').first().waitFor({ timeout: 45000 });
  await page.waitForFunction(expected => document.querySelector('.project-name')?.getAttribute('title') === expected, JSON.parse(await fs.readFile(file, 'utf8')).name);
}
async function setRange(page, label, value) {
  const slider = page.getByRole('slider', { name: label });
  await slider.evaluate((element, next) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(element, String(next));
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  await page.waitForFunction(([name, expected]) => Number(document.querySelector(`[aria-label="${name}"]`)?.value) === expected, [label, value]);
}
async function makeFixture(file, color, frequency) {
  execFileSync(ffmpeg, [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=30:d=8`,
    '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=44100:duration=8`,
    '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '64k', file,
  ], { stdio: 'pipe' });
}
async function end(instance) {
  if (!instance) return;
  const child = instance.process();
  const pid = child?.pid;
  await instance.close().catch(() => {});
  if (pid && child?.exitCode === null) {
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already exited */ }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
}

try {
  ({ instance: app, page } = await launch());
  await stubPicker(app, demo);
  await page.getByRole('button', { name: 'Open Demo' }).click();
  await page.getByRole('heading', { name: /Whose perspective/ }).waitFor({ timeout: 120000 });
  await page.locator('.team-choices button').first().click();
  const after = await fs.readdir(root);
  const created = after.filter(name => !before.has(name));
  assert.equal(created.length, 1, `Expected one imported project, got ${created.join(', ')}`);
  projectDir = path.resolve(root, created[0]);
  assert.ok(projectDir.startsWith(root + path.sep));
  const file = path.join(projectDir, 'project.json');
  const project = JSON.parse(await fs.readFile(file, 'utf8'));
  const match = JSON.parse(await fs.readFile(path.join(projectDir, 'match.json'), 'utf8'));
  assert.equal(match.teams[0].playerIds.length, 5);
  assert.equal(match.teams[1].playerIds.length, 5);

  // UI-only media fixtures, never represented as HLAE output or retained as POVs.
  fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tacticlab-ui-pov-'));
  const first = path.join(fixtureDir, 'ui-fixture-1.mp4');
  const second = path.join(fixtureDir, 'ui-fixture-2.mp4');
  await makeFixture(first, 'blue', 440);
  await makeFixture(second, 'yellow', 660);
  const team = match.teams.find(item => item.id === project.selectedTeam);
  const span = 8 * match.tickRate;
  project.pov = [first, second].map((videoPath, index) => ({
    playerId: team.playerIds[index], steamId: team.playerIds[index], path: videoPath,
    proxyPath: videoPath, videoStartTick: match.startTick,
    videoEndTick: match.startTick + span, tickRate: match.tickRate,
    duration: 8, fps: 30, hasAudio: true, source: 'imported', syncVerified: false,
  }));
  await fs.writeFile(file, JSON.stringify(project, null, 2));
  await openProject(app, page, file);

  const timeline = page.getByRole('slider', { name: 'Global timeline' });
  const initial = Number(await timeline.inputValue());
  await page.getByRole('button', { name: /^Player 1 POV:/ }).click();
  await page.waitForFunction(() => document.querySelector('.main.pov-view') && document.querySelector('.view-tabs button')?.classList.contains('active') && !document.querySelector('.tactical-tile')?.classList.contains('selected'));
  await page.waitForFunction(() => document.querySelector('.main-video:not(.hidden-video)')?.dataset.synced === 'true');
  assert.equal(Number(await timeline.inputValue()), initial);
  await page.getByRole('button', { name: /^Player 2 POV:/ }).click();
  await page.waitForFunction(() => document.querySelector('.main-video:not(.hidden-video)')?.dataset.synced === 'true');
  assert.equal(Number(await timeline.inputValue()), initial);
  await page.getByRole('button', { name: '2D tactical view' }).click();
  assert.equal(Number(await timeline.inputValue()), initial);
  await page.getByRole('button', { name: /^Player 1 POV:/ }).click();
  assert.equal(Number(await timeline.inputValue()), initial);

  const target1 = match.startTick + 2 * match.tickRate;
  await setRange(page, 'Global timeline', target1);
  await page.waitForFunction(() => document.querySelector('.main-video:not(.hidden-video)')?.dataset.synced === 'true');
  const videoSeconds = await page.locator('.main-video:not(.hidden-video)').evaluate(video => video.currentTime);
  assert.ok(Math.abs(videoSeconds - 2) < 0.12, `Video time ${videoSeconds} is not aligned to tick ${target1}`);
  await page.getByRole('button', { name: '2D tactical view' }).click();
  assert.equal(Number(await timeline.inputValue()), target1);
  await page.getByRole('button', { name: /^Player 1 POV:/ }).click();
  assert.equal(Number(await timeline.inputValue()), target1);
  await setRange(page, 'Volume', 0.35);
  await page.getByRole('combobox', { name: 'Playback speed' }).selectOption('2');
  await page.getByRole('button', { name: '2D tactical view' }).click();
  await page.getByRole('button', { name: /^Player 1 POV:/ }).click();
  assert.equal(await page.getByRole('slider', { name: 'Volume' }).inputValue(), '0.35');
  assert.equal(await page.getByRole('combobox', { name: 'Playback speed' }).inputValue(), '2');

  await page.getByRole('button', { name: '2D tactical view' }).click();
  await page.getByRole('button', { name: 'Capture current step' }).click();
  await page.getByRole('button', { name: 'Step 2' }).click();
  const target2 = match.startTick + 3 * match.tickRate;
  await setRange(page, 'Global timeline', target2);
  await page.getByRole('button', { name: 'Capture current step' }).click();
  await page.getByRole('button', { name: 'Return to replay' }).click();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.getByRole('button', { name: 'Pause', exact: true }).waitFor();
  await page.getByRole('button', { name: /^Player 3 POV:/ }).click();
  const uncoveredTick = Number(await timeline.inputValue());
  await page.waitForFunction(previous => Number(document.querySelector('[aria-label="Global timeline"]')?.value) > previous, uncoveredTick);
  await page.getByRole('button', { name: 'Pause', exact: true }).waitFor();
  await page.getByRole('button', { name: /^Player 1 POV:/ }).click();
  await page.getByRole('button', { name: 'Pause', exact: true }).waitFor();
  await page.getByRole('button', { name: '2D tactical view' }).click();
  await page.getByRole('button', { name: 'Pause', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.waitForFunction(() => !!document.querySelector('.project-name em'));
  await new Promise(resolve => setTimeout(resolve, 100));
  const stayedOpen = await app.evaluate(({ dialog, BrowserWindow }) => {
    const original = dialog.showMessageBoxSync;
    dialog.showMessageBoxSync = () => 0;
    const window = BrowserWindow.getAllWindows()[0];
    window.close();
    dialog.showMessageBoxSync = original;
    return !window.isDestroyed();
  });
  assert.ok(stayedOpen, 'Closing a dirty project should offer Keep editing.');
  await page.getByRole('button', { name: 'Save Project', exact: true }).last().click();
  await page.waitForFunction(() => !document.querySelector('.project-name em'));
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(saved.tactics[0].steps[0].tick, target1);
  assert.equal(saved.tactics[0].steps[1].tick, target2);
  assert.ok(saved.tactics[0].steps[0].captured && saved.tactics[0].steps[1].captured);

  await page.reload();
  await openProject(app, page, file);
  await page.getByRole('button', { name: 'Step 1' }).click();
  assert.equal(Number(await timeline.inputValue()), target1);
  await page.getByRole('button', { name: 'Step 2' }).click();
  assert.equal(Number(await timeline.inputValue()), target2);
  await page.getByRole('button', { name: 'Save Project', exact: true }).last().click();
  await page.waitForFunction(() => !document.querySelector('.project-name em'));
  await page.screenshot({ path: 'artifacts/ui-tactical.png' });
  await end(app);
  app = undefined;

  ({ instance: app, page } = await launch());
  await openProject(app, page, file);
  await page.getByRole('button', { name: '2D tactical view' }).click();
  await page.getByRole('button', { name: 'Step 2' }).click();
  assert.equal(Number(await page.getByRole('slider', { name: 'Global timeline' }).inputValue()), target2);
  assert.equal(await page.locator('.project-name').getAttribute('title'), project.name);
  await page.getByRole('button', { name: /^Player 1 POV:/ }).click();
  await page.waitForFunction(() => document.querySelector('.main.pov-view') && document.querySelector('.view-tabs button')?.classList.contains('active') && !document.querySelector('.tactical-tile')?.classList.contains('selected'));
  await page.waitForFunction(() => document.querySelector('.main-video:not(.hidden-video)')?.dataset.synced === 'true');
  await page.screenshot({ path: 'artifacts/ui-pov.png' });
  await page.setViewportSize({ width: 1050, height: 700 });
  await page.getByRole('button', { name: '2D tactical view' }).click();
  const compact = await page.evaluate(() => ({
    lastTileBottom: document.querySelector('.tactical-tile').getBoundingClientRect().bottom,
    toolbarHeight: document.querySelector('.drawing-toolbar').getBoundingClientRect().height,
    toolbarRows: [...document.querySelectorAll('.drawing-toolbar > .icon-button, .drawing-toolbar > .toolbar-steps')].map(element => Math.round(element.getBoundingClientRect().top)),
    viewportHeight: innerHeight,
  }));
  assert.ok(compact.lastTileBottom < compact.viewportHeight, 'All six left tiles must remain visible at the minimum window size.');
  assert.ok(compact.toolbarHeight < 45 && new Set(compact.toolbarRows).size === 1, 'The tactical toolbar must stay on one row.');
  await page.screenshot({ path: 'artifacts/ui-compact.png' });
  assert.deepEqual(errors, []);
  await fs.writeFile('artifacts/ui-e2e-report.json', JSON.stringify({
    demo, importedPlayers: match.players.length, povSwitchTick: initial,
    videoSeekTick: target1, videoSeconds, stepTicks: [target1, target2],
    reloaded: true, restarted: true, dirtyCloseConfirmed: stayedOpen,
    playbackStatePreserved: true, volumeAndSpeedPreserved: true, compact, errors,
    note: 'POV videos in this test are synthetic media fixtures for UI timing only; no real HLAE capture is claimed.',
  }, null, 2));
  console.log('PASS: demo import, two POV switches, 2D continuity, video seek, two steps, reload, save and restart.');
} finally {
  await end(app);
  if (projectDir && projectDir.startsWith(root + path.sep)) {
    await fs.rm(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
  if (fixtureDir.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(fixtureDir).startsWith('tacticlab-ui-pov-')) {
    await fs.rm(fixtureDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
  if (userDataDir.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(userDataDir).startsWith('tacticlab-ui-userdata-')) {
    await fs.rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}

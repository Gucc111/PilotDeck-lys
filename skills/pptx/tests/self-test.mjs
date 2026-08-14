import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(skillRoot, 'scripts', 'pptx.sh');
const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pilotdeck-pptx-test-'));
const workDir = path.join(outputRoot, 'work');
const environment = { ...process.env, PILOTDECK_WORK_DIR: workDir };
let passed = false;

function run(command, args = []) {
  const result = spawnSync(command, args, {
    cwd: skillRoot,
    env: environment,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

function pptx(...args) {
  return run('bash', [cli, ...args]);
}

try {
  await fs.mkdir(workDir, { recursive: true });
  const builder = path.join(workDir, 'deck.mjs');
  const candidate = path.join(workDir, 'candidate.pptx');
  const bomCandidate = path.join(workDir, 'candidate-with-bom.pptx');
  const editBuilder = path.join(workDir, 'edit.mjs');
  const edited = path.join(workDir, 'edited.pptx');
  const evaluator = path.join(workDir, 'evaluator.mjs');
  const evaluation = path.join(workDir, 'evaluation.json');
  const reviewDir = path.join(workDir, 'review');
  const converted = path.join(workDir, 'converted.pptx');
  const conversionReview = path.join(workDir, 'conversion-review');
  const final = path.join(outputRoot, 'final.pptx');

  const check = pptx('check');
  assert.equal(check.status, 'ok');
  process.env.PPTX_RUNTIME_ROOT = check.runtime;
  pptx('scaffold', '--out', builder);
  const built = pptx('build', '--builder', builder, '--out', candidate);
  assert.equal(built.slideCount, 2);

  const manifest = pptx('inspect', '--input', candidate);
  const title = manifest.slides[0].objects.find((object) => object.text.includes('A clear presentation'));
  assert.ok(title?.name, 'starter title needs a stable object name');

  const { loadDependencies } = await import('../scripts/lib/runtime.mjs');
  const { JSZip } = loadDependencies();
  const bomZip = await JSZip.loadAsync(await fs.readFile(candidate));
  for (const part of [
    'ppt/presentation.xml',
    'ppt/_rels/presentation.xml.rels',
    'ppt/slides/slide1.xml',
    'ppt/theme/theme1.xml',
  ]) {
    const file = bomZip.file(part);
    if (!file) continue;
    const xml = await file.async('string');
    bomZip.file(part, `\uFEFF${xml.replace(/^\uFEFF/u, '')}`);
  }
  await fs.writeFile(bomCandidate, await bomZip.generateAsync({ type: 'nodebuffer' }));
  const bomManifest = pptx('inspect', '--input', bomCandidate);
  assert.equal(bomManifest.slideCount, manifest.slideCount);
  assert.deepEqual(
    bomManifest.slides.map((slide) => slide.text),
    manifest.slides.map((slide) => slide.text),
  );

  const conversion = pptx(
    'convert-legacy',
    '--input', candidate,
    '--out', converted,
    '--qa-dir', conversionReview,
  );
  assert.equal(conversion.status, 'converted');
  assert.equal(conversion.validation.status, 'review_pending');
  assert.equal(conversion.validation.sourceRender.slideCount, 2);
  assert.equal(conversion.validation.convertedRender.slideCount, 2);
  await fs.writeFile(editBuilder, [
    'export default async function build({ createTemplatePresentation }) {',
    '  const template = await createTemplatePresentation();',
    `  template.addSlide(1, (slide) => slide.modifyElement(${JSON.stringify(title.name)}, [template.ModifyTextHelper.setText('Template editing stays model-directed')]));`,
    '  return template;',
    '}',
    '',
  ].join('\n'));

  const templateBuild = pptx('build', '--builder', editBuilder, '--input', candidate, '--out', edited);
  assert.equal(templateBuild.engine, 'pptx-automizer');
  const editedManifest = pptx('inspect', '--input', edited);
  assert.match(editedManifest.slides[0].text, /Template editing stays model-directed/);

  await fs.writeFile(evaluator, [
    'export default async function evaluate({ candidate, helpers }) {',
    '  return { checks: [',
    "    { name: 'one selected slide', passed: candidate.slideCount === 1 },",
    "    { name: 'edited text present', passed: helpers.findText('Template editing stays model-directed').length === 1 },",
    '  ] };',
    '}',
    '',
  ].join('\n'));
  assert.equal(pptx('evaluate', '--input', edited, '--script', evaluator, '--out', evaluation).status, 'ok');

  const review = pptx('review', '--input', edited, '--out-dir', reviewDir);
  assert.ok(['review_pending', 'evidence_unavailable'].includes(review.status));
  assert.equal(review.structure.slideCount, 1);
  assert.equal(review.structure.slides, undefined);
  assert.equal(review.audit.errors, undefined);
  assert.ok(await fs.stat(review.audit.report).then((stat) => stat.isFile()));
  const fullReview = JSON.parse(await fs.readFile(review.report, 'utf8'));
  assert.equal(fullReview.structure.slides.length, 1);
  assert.ok(Array.isArray(fullReview.audit.errors));
  assert.ok(JSON.stringify(review).length < JSON.stringify(fullReview).length);
  if (review.status === 'review_pending') {
    assert.equal(review.render.pages.length, 1);
    assert.ok(await fs.stat(review.render.pages[0].image).then((stat) => stat.isFile()));
  }

  const delivered = pptx('deliver', '--input', edited, '--out', final);
  assert.equal(delivered.slideCount, 1);
  assert.ok(await fs.stat(final).then((stat) => stat.isFile()));
  passed = true;
  process.stdout.write(`${JSON.stringify({ status: 'ok', checks: ['build', 'bom-ooxml', 'convert', 'template-edit', 'evaluate', 'compact-review', 'deliver'] })}\n`);
} finally {
  if (passed) await fs.rm(outputRoot, { recursive: true, force: true });
  else process.stderr.write(`PPTX self-test artifacts: ${outputRoot}\n`);
}

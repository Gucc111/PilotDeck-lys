import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
  const compatibilityCandidate = path.join(workDir, 'candidate-with-ooxml-variants.pptx');
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
  const { JSZip, xmldom } = loadDependencies();
  const compatibilityZip = await JSZip.loadAsync(await fs.readFile(candidate));
  const relationshipNamespace = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const xmlnsNamespace = 'http://www.w3.org/2000/xmlns/';
  const relationshipOwnerPart = (part) => {
    if (part === '_rels/.rels') return '';
    const match = part.match(/^(.*)\/_rels\/([^/]+)\.rels$/u);
    return match ? path.posix.join(match[1], match[2]) : null;
  };
  const elementDescendants = (node) => {
    const values = [];
    const visit = (current) => {
      for (let child = current?.firstChild; child; child = child.nextSibling) {
        if (child.nodeType !== 1) continue;
        values.push(child);
        visit(child);
      }
    };
    visit(node);
    return values;
  };
  let absoluteRelationshipTargets = 0;
  let localRelationshipNamespaces = 0;
  let bomParts = 0;
  for (const part of Object.keys(compatibilityZip.files)) {
    const file = compatibilityZip.file(part);
    if (!file || !(part.endsWith('.xml') || part.endsWith('.rels'))) continue;
    const xml = (await file.async('string')).replace(/^\uFEFF/u, '');
    const document = new xmldom.DOMParser().parseFromString(xml, 'application/xml');
    if (part.endsWith('.rels')) {
      const ownerPart = relationshipOwnerPart(part);
      assert.notEqual(ownerPart, null);
      for (const relationship of elementDescendants(document).filter((node) => node.localName === 'Relationship')) {
        if (String(relationship.getAttribute('TargetMode') ?? '').toLowerCase() === 'external') continue;
        const target = relationship.getAttribute('Target');
        const resolved = target.startsWith('/')
          ? path.posix.normalize(target.slice(1))
          : path.posix.normalize(path.posix.join(path.posix.dirname(ownerPart), target));
        relationship.setAttribute('Target', `/${resolved}`);
        absoluteRelationshipTargets += 1;
      }
    } else if (part.startsWith('ppt/')) {
      const root = document.documentElement;
      if (root?.getAttribute('xmlns:r') === relationshipNamespace) {
        for (const element of elementDescendants(root)) {
          const usesRelationshipsPrefix = Array.from({ length: element.attributes?.length ?? 0 })
            .some((_, index) => element.attributes.item(index)?.prefix === 'r');
          if (!usesRelationshipsPrefix) continue;
          element.setAttributeNS(xmlnsNamespace, 'xmlns:r', relationshipNamespace);
          localRelationshipNamespaces += 1;
        }
        root.removeAttributeNS(xmlnsNamespace, 'r');
        root.removeAttribute('xmlns:r');
      }
    }
    compatibilityZip.file(part, `\uFEFF${new xmldom.XMLSerializer().serializeToString(document)}`);
    bomParts += 1;
  }
  assert.ok(bomParts > 0);
  assert.ok(absoluteRelationshipTargets > 0);
  assert.ok(localRelationshipNamespaces > 0);
  await fs.writeFile(compatibilityCandidate, await compatibilityZip.generateAsync({ type: 'nodebuffer' }));
  const compatibilitySourceHash = crypto.createHash('sha256').update(await fs.readFile(compatibilityCandidate)).digest('hex');
  const compatibilityManifest = pptx('inspect', '--input', compatibilityCandidate);
  assert.equal(compatibilityManifest.slideCount, manifest.slideCount);
  assert.deepEqual(
    compatibilityManifest.slides.map((slide) => slide.text),
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

  const templateBuild = pptx('build', '--builder', editBuilder, '--input', compatibilityCandidate, '--out', edited);
  assert.equal(templateBuild.engine, 'pptx-automizer');
  assert.equal(
    crypto.createHash('sha256').update(await fs.readFile(compatibilityCandidate)).digest('hex'),
    compatibilitySourceHash,
  );
  assert.deepEqual(
    (await fs.readdir(workDir)).filter((name) => name.endsWith('.template.pptx')),
    [],
    'normalized template copies should be cleaned up after the build',
  );
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
  process.stdout.write(`${JSON.stringify({ status: 'ok', checks: ['build', 'ooxml-compatibility', 'convert', 'template-edit', 'evaluate', 'compact-review', 'deliver'] })}\n`);
} finally {
  if (passed) await fs.rm(outputRoot, { recursive: true, force: true });
  else process.stderr.write(`PPTX self-test artifacts: ${outputRoot}\n`);
}

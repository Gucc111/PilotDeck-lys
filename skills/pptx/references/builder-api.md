# Builder API

Use one plain JavaScript ES module for each candidate revision. Export one async function. The runtime owns dependency loading, input and output paths, validation, and candidate promotion.

## New presentations

Return a PptxGenJS presentation:

```js
export default async function build({ createDeck, pptxgenjs, imageSizingCrop }) {
  const pptx = await createDeck({
    title: 'Example',
    lang: 'zh-CN',
    headFontFace: 'Arial',
    bodyFontFace: 'Arial',
  });
  const slide = pptx.addSlide();
  slide.addText('A useful conclusion', {
    objectName: 'Slide Title',
    x: 0.8, y: 0.6, w: 11.7, h: 0.6,
    fontFace: 'Arial',
    fontSize: 28,
    bold: true,
    margin: 0,
  });
  return pptx;
}
```

Toolkit members include:

- `createDeck(options)` for a wide editable presentation with optional language, font, and metadata choices.
- The complete `pptxgenjs` package for slide authoring.
- `imageSizingCrop(path, x, y, w, h)` and `imageSizingContain(...)`.
- `inputPath`, which is set when `build --input` is used.

`createDeck` does not choose a palette or slide composition. The starter builder is deliberately minimal; replace its content and composition rather than treating it as a template.

## Template inheritance and existing PPTX files

Build with `--input source.pptx`, then use `createTemplatePresentation()` inside the builder:

```js
export default async function build({ createTemplatePresentation }) {
  const template = await createTemplatePresentation();

  template.addSlide(3, (slide) => {
    slide.modifyElement('Title 1', [
      template.ModifyTextHelper.setText('Updated audience-facing title'),
    ]);
  });

  template.addSlide(7);
  return template;
}
```

The returned object exposes the underlying `presentation`, `automizer`, `ModifyTextHelper`, `ModifyImageHelper`, and `modify` APIs. Use pptx-automizer directly for capabilities beyond the convenience methods.

Use `template.loadMedia(imagePath)` before replacing an image. Refer to object names from `inspect` output. Select, reorder, or repeat source slides according to the request; there is no frame-map schema or fixed action list.

Preserve charts, diagrams, media, OLE objects, animations, and complex master content when the requested change does not require touching them. If a requested edit cannot be expressed safely, report the limitation instead of rebuilding the whole source deck or hiding replacement objects over inaccessible content.

## Builder discipline

- Keep the builder under `PILOTDECK_WORK_DIR` and rerun it through `pptx.sh build`.
- Do not choose or write the final path inside the builder.
- Give important objects stable `objectName` values when future edits are likely.
- Keep source materials separate from the output candidate.
- Use native editable PowerPoint objects when practical; prepared SVG or raster assets are appropriate for complex visuals.

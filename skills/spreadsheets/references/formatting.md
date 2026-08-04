# Formatting

## Preserve an existing workbook

- Render the source workbook before editing it.
- Inspect the target range's fills, fonts, borders, alignment, merged cells, number formats, widths, and row heights.
- Change values without replacing existing styles.
- Extend surrounding formulas, table ranges, validations, and conditional formatting when adding rows or columns.
- Make the smallest plausible visual change. Do not apply sheet-wide autofit or restyling without a redesign request.

## Baseline for a new workbook

- When no template or concrete style is supplied, use `neutral-built-in` and select the correct workbook type during `prepare`.
- For `data`, `tracker`, and `model`, start the usable table at the top of the sheet. Do not add a merged banner, oversized title, KPI cards, decorative blank rows, or a dashboard shell.
- Use bold dark text, white or light-gray header fill, and a thin neutral bottom border. Do not make ordinary headers blue or activate a colored theme from generic words such as “professional”.
- Use `TableStyleLight1`. Other built-in table themes are not part of the neutral default.
- Keep the body white. Use color only for requested branding or semantic input/status/warning meaning.
- Keep gridlines visible for ordinary data sheets. Hide them only when a dashboard/report layout supplies an equally clear structure.
- Freeze header rows or identifier columns for large sheets.
- Apply formatting only to populated or intentionally reserved ranges.

## Style modes and workbook types

- `preserve-source`: inspect and preserve the source's visual language. Do not apply the neutral template over an existing workbook.
- `user-template`: use only the frozen template or explicit user tokens. Generic genres are not style sources.
- `neutral-built-in`: enforce the neutral rules during audit and delivery.
- `data`: compact grid/table, filters, frozen headers, no decorative title.
- `tracker`: data rules plus restrained semantic status colors.
- `model`: separate inputs, formulas, and outputs with minimal semantic formatting.
- `dashboard` or `report`: titles, KPI blocks, hidden gridlines, and accent colors are allowed only when that archetype is explicitly selected.
- `template`: preserve the template structure and formatting.

## Typography and alignment

- For Chinese, bilingual, or unspecified-language workbooks, follow [chinese-and-cross-platform.md](chinese-and-cross-platform.md).
- Use one neutral body-font profile. Do not promise a universal CJK font; XLSX does not reliably embed fonts.
- Use bold sparingly to establish reading order.
- Left-align descriptions, right-align numbers, and apply explicit date/number formats.
- Widen columns before creating deeply wrapped rows.
- Keep row heights consistent within a section.
- Use CJK-aware `helpers.autoFitColumns`; use `helpers.autoFitRows` after widths are final for wrapped text.

## Number formats

Use invariant Excel format codes:

- Count: `#,##0`
- Decimal: `#,##0.0`
- Percentage: `0.0%`
- Currency: `"$"#,##0` or a currency requested by the user
- Chinese yuan: `¥#,##0` or `¥#,##0.00`
- Date: `yyyy-mm-dd`
- Month: `mmm yyyy`

Use enough precision to support the decision, not every available decimal place.

## Tables and summaries

- Use a native table when filters, banding, or structured growth improve usability.
- Keep table names unique and stable.
- Show important totals near the top or in a summary block, driven by formulas.
- Use conditional formatting for status, thresholds, variances, and exceptions.
- Do not merge cells inside calculation tables. Reserve merging for titles and section labels.

## Visual QA

At full-size render, verify:

- Headers and important numbers are not clipped.
- Wrapped text is readable and row heights are sufficient.
- Units, currency, dates, and percentages display correctly.
- Sections do not overlap and pages do not contain accidental blank areas caused by a bloated used range.
- Print scaling does not make the workbook unreadably small.

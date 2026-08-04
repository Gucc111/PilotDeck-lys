export default async function build({ createWorkbook, helpers }) {
  const workbook = createWorkbook();
  const sheet = workbook.addWorksheet("Summary", {
    views: [{ state: "frozen", ySplit: 1, showGridLines: true }],
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  sheet.addRows([
    ["月份", "收入", "成本", "利润率", "状态"],
    ["1月", 100000, 70000, null, "正常"],
    ["2月", 120000, 78000, null, "正常"],
    ["3月", 135000, 85000, null, "关注"],
  ]);
  helpers.styleHeader(sheet, "A1:E1");

  for (let row = 2; row <= 4; row += 1) {
    sheet.getCell(`D${row}`).value = { formula: `IFERROR((B${row}-C${row})/B${row},0)`, result: 0 };
  }
  helpers.addTableFromRange(sheet, { name: "SummaryData", range: "A1:E4" });
  helpers.setNumberFormat(sheet, "B2:C4", '¥#,##0');
  helpers.setNumberFormat(sheet, "D2:D4", "0.0%");
  helpers.addListValidation(sheet, "E2:E4", ["正常", "关注", "风险"]);
  helpers.addConditionalFormatting(sheet, {
    range: "D2:D4",
    rules: [{ type: "cellIs", operator: "lessThan", formulae: [0.25], style: { font: { color: { argb: "FFB91C1C" } } } }],
  });
  helpers.autoFitColumns(sheet, { min: 11, max: 24 });
  helpers.applyChineseTypography(sheet, { platform: "cross-platform" });
  helpers.addNativeChart(workbook, {
    sheet: "Summary",
    type: "line",
    title: "收入与成本趋势",
    minPoints: 3,
    categories: "A2:A4",
    series: [
      { name: "收入", values: "B2:B4", color: "334155" },
      { name: "成本", values: "C2:C4", color: "94A3B8" },
    ],
    anchor: { from: "G1", to: "N16" },
    valueFormat: "¥#,##0",
  });

  return {
    workbook,
    requirements: {
      requiredSheets: ["Summary"],
      minFormulaCount: 3,
      requiredFormulaRanges: [{ sheet: "Summary", range: "D2:D4" }],
      expectedRanges: [{
        sheet: "Summary",
        range: "A2:C4",
        values: [["1月", 100000, 70000], ["2月", 120000, 78000], ["3月", 135000, 85000]],
      }],
      requiredNativeCharts: [{ sheet: "Summary", type: "line", minCount: 1, minPoints: 3, sourceRanges: ["A2:A4", "B2:B4", "C2:C4"] }],
      requiredTables: [{ sheet: "Summary", minCount: 1 }],
      requiredConditionalFormatting: [{ sheet: "Summary", range: "D2:D4" }],
      requiredDataValidations: [{ sheet: "Summary", cell: "E2" }],
      requiredCellTypes: [
        { sheet: "Summary", range: "A2:A4", type: "string" },
        { sheet: "Summary", range: "B2:D4", type: "number" },
      ],
    },
  };
}

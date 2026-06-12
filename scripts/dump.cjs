const XLSX = require("xlsx");
const file = process.argv[2] || "Porra_Mundial_2026_Danel.xlsx";
const sheets = process.argv.slice(3);
const wb = XLSX.readFile(file);
for (const name of sheets.length ? sheets : wb.SheetNames) {
  const ws = wb.Sheets[name];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
  console.log("=====", name, "=====");
  rows.forEach((r, i) => {
    // trim trailing nulls
    while (r.length && r[r.length - 1] === null) r.pop();
    if (r.length) console.log(i, JSON.stringify(r));
  });
}

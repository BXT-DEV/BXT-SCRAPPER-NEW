import fs from "fs";
import csvParser from "csv-parser";

const filePath = "/Volumes/BISMILLAH/BXT-SCRAPPER/Barang Brand New Audit Mapping.csv";

fs.createReadStream(filePath)
  .pipe(csvParser({ separator: ";" }))
  .on("data", (row) => {
    console.log("Row keys:", Object.keys(row));
    console.log("Row values:", row);
    process.exit(0);
  })
  .on("error", (err) => {
    console.error(err);
  });

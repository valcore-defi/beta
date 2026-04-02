import { readFileSync } from "fs";
try {
  let raw = readFileSync("oracle-logs.json");
  if (raw[0] === 0xff && raw[1] === 0xfe) raw = raw.slice(2);
  let str = raw.toString("utf16le").trim();
  if (str[0] !== "[") {
      str = raw.toString("utf8").trim();
  }
  const data = JSON.parse(str);
  for (const entry of data.reverse()) {
    if (entry.textPayload) console.log(entry.textPayload.trim());
    if (entry.jsonPayload?.message) console.log(entry.jsonPayload.message.trim());
  }
} catch(e) {
  console.log("Error:", e.message);
}

const fs = require("fs");
const path = require("path");
const langsDir = path.resolve(__dirname, "..", "languages");

// vue-i18n treats '@' as the linked-message marker. Escape it with {'@'} so
// the literal '@fix' / '@msl' hint renders instead of throwing
// "SyntaxError: Invalid linked format".
const FIXES = {
  TXT_CODE_agent_placeholder_en: "Describe what you want the Agent to do\u2026 (try {'@'}fix or {'@'}msl)",
  TXT_CODE_agent_placeholder_zh: "\u63cf\u8ff0\u4f60\u60f3\u8ba9 Agent \u505a\u4ec0\u4e48\u2026\uff08\u8bd5\u8bd5 {'@'}fix \u6216 {'@'}msl\uff09"
};

let updated = 0;
for (const f of fs.readdirSync(langsDir)) {
  if (!f.endsWith(".json")) continue;
  const file = path.join(langsDir, f);
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  const isZh = f.toLowerCase().includes("zh");
  if (typeof j.TXT_CODE_agent_placeholder === "string" && j.TXT_CODE_agent_placeholder.includes("@fix")) {
    j.TXT_CODE_agent_placeholder = isZh ? FIXES.TXT_CODE_agent_placeholder_zh : FIXES.TXT_CODE_agent_placeholder_en;
    fs.writeFileSync(file, JSON.stringify(j, null, 2));
    updated++;
    console.log("fixed", f);
  }
}
console.log("total fixed:", updated);

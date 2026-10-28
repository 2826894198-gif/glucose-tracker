const STORAGE_SLOT = "blood-glucose-records-v1";

const records = JSON.parse(localStorage.getItem(STORAGE_SLOT) || "[]");
const kept = Array.isArray(records) ? records.filter((record) => !record.demo) : [];

localStorage.setItem(STORAGE_SLOT, JSON.stringify(kept));
console.log(`已清除演示记录，保留 ${kept.length} 条非演示记录。刷新页面后生效。`);

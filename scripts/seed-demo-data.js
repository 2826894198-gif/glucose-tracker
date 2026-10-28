const STORAGE_SLOT = "blood-glucose-records-v1";

const periods = ["morning", "noon", "evening"];
const mealTypes = {
  morning: ["fasting", "postMeal"],
  noon: ["preMeal", "postMeal"],
  evening: ["preMeal", "postMeal"]
};

const notes = [
  "",
  "饭后散步20分钟",
  "昨晚睡眠一般",
  "早餐较清淡",
  "中午主食较多",
  "晚饭偏晚"
];

function pad(value) {
  return String(value).padStart(2, "0");
}

function dateTime(daysAgo, hour, minute) {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hour, minute, 0, 0);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(hour)}:${pad(minute)}`;
}

function glucoseFor(mealType, index) {
  const base = mealType === "postMeal" ? 8.2 : 5.8;
  const wave = Math.sin(index * 1.7) * 1.1;
  const spike = index % 9 === 0 ? 2.8 : index % 13 === 0 ? -2.1 : 0;
  return Math.max(3.2, Number((base + wave + spike).toFixed(1)));
}

const records = [];

for (let day = 0; day < 21; day += 1) {
  periods.forEach((period, periodIndex) => {
    if ((day + periodIndex) % 7 === 2) return;

    const selectedMealTypes = mealTypes[period];
    const shouldDouble = (day + periodIndex) % 4 === 0;
    const count = shouldDouble ? 2 : 1;

    selectedMealTypes.slice(0, count).forEach((mealType, mealIndex) => {
      const hour = period === "morning" ? 7 + mealIndex * 2 : period === "noon" ? 11 + mealIndex * 2 : 18 + mealIndex * 2;
      const index = day * 3 + periodIndex + mealIndex;
      records.push({
        id: `demo-${day}-${period}-${mealType}`,
        measuredAt: dateTime(day, hour, mealIndex ? 20 : 10),
        period,
        mealType,
        postMealMinutes: mealType === "postMeal" ? 120 : null,
        glucose: glucoseFor(mealType, index),
        tookMedicine: (day + periodIndex + mealIndex) % 3 !== 0,
        note: notes[index % notes.length],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        demo: true
      });
    });
  });
}

localStorage.setItem(STORAGE_SLOT, JSON.stringify(records));
console.log(`已生成 ${records.length} 条演示记录。刷新页面后生效。`);

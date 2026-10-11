# Data contract — `plan.json` & `progress.json`

兩個檔 = 成個系統嘅真源。

- `plan.json` — **計劃**（Project-Manager 寫，規劃期）。慢變。
- `progress.json` — **人手 tick 嘅進度**（app 寫）。快變。**Project-Manager 永不寫呢個檔。**

App（Project Console）只讀呢兩個檔 + 渲染；tick 只改 `progress.json`。

---

## `plan.json`（schema `omo-project/plan@2`）

```json
{
  "schema": "omo-project/plan@2",
  "id": "example-project",
  "title": "Example Project",
  "owner": "Jack",
  "created": "2026-10-11",
  "target": "2026-11-15",
  "protocol": "waterfall | agile | hybrid",
  "definition_of_done": "一句可判定的 DoD",
  "scope": { "in": ["..."], "out": ["..."] },
  "constraints": {
    "time": "2026-11-15 deadline",
    "resource": "3 個人、每週 10 小時",
    "procedure": "用邊個工具 / 流程 / 模板",
    "scope": "固定，變更要 Jack 批"
  },
  "phases": [
    { "id": "P1", "name": "Script" },
    { "id": "P2", "name": "Assets" }
  ],
  "tasks": [
    {
      "id": "T1.1",
      "phase": "P1",
      "title": "Write script + storyboard",
      "deliverable": "script.md",
      "deps": [],
      "owner": "Jack",
      "start": "2026-10-11",
      "estimate_days": 1,
      "acceptance": "三段式腳本，每段有秒數 + 畫面描述",
      "outputs": ["artifacts/script.md"]
    }
  ],
  "milestones": [
    { "id": "M1", "name": "Storyboard locked", "date": "2026-10-12", "after": ["T1.1"] }
  ],
  "resources": {
    "people": [
      { "name": "Jack", "role": "CEO", "skills": ["統籌", "剪接"], "weekly_hours": 10, "note": "approval" },
      { "name": "Dorian", "role": "隊友", "skills": ["素材"], "weekly_hours": 4, "note": "" }
    ],
    "materials": [
      { "item": "外置收音麥", "type": "equipment", "have": false, "source": "買 / 借", "note": "預算 HK$600" }
    ],
    "sources": [{ "kind": "oneDrive", "path": "Startup/business/" }],
    "time": { "start": "2026-10-11", "weekly_hours": 14, "deadline": "2026-11-15" }
  },
  "cost": {
    "currency": "HKD",
    "budget": 2000,
    "funding_source": "自費 / MicroFund 資助",
    "line_items": [
      { "item": "外置收音麥", "unit_cost": 600, "qty": 1, "total": 600, "paid": false, "note": "" },
      { "item": "雲端儲存", "unit_cost": 50, "qty": 6, "total": 300, "paid": false, "note": "每月" }
    ],
    "spent": 0
  },
  "risks": [
    { "id": "R1", "risk": "素材不足", "likelihood": "M", "impact": "H", "response": "mitigate", "owner": "Dorian", "note": "先儲備 5 張" }
  ]
}
```

### 欄位規則

- `id`（task/milestone/risk）：project 內唯一。task id 用 `T<phase>.<n>`。
- `deps`：task id 陣列。ready = 所有 deps 都已完成（人手 tick）。
- **`owner` = 人嘅名**（例：`"Jack"`、`"Dorian"`）。**冇 category / agent / subagent。**
- `start`（YYYY-MM-DD）+ `estimate_days`：驅動 Gantt 嘅計劃 bar。
- `acceptance`：**可判定**嘅完成定義（唔可以「做得好」）。
- `outputs`：交付物路徑（相對 project folder）。
- `response`：`avoid` / `mitigate` / `transfer` / `accept`（對應 ENG4001 W4）。
- **`resources`**：`people[]`（人：名字 / 角色 / 技能 / 每週鐘數）、`materials[]`（設備 / 材料 / 工具 / 場地：item / type / have / source）、`sources[]`、`time`（start / weekly_hours / deadline）。**7 維度之一，唔可以空。**
- **`cost`**：`currency` / `budget`（上限）/ `funding_source`（資金來源）/ `line_items[]`（item / unit_cost / qty / total / paid）/ `spent`。**7 維度之一，唔可以空**（真係冇成本就寫 `budget: 0` 同註明）。

---

## `progress.json`（schema `omo-project/progress@1`）— 人手 tick

```json
{
  "schema": "omo-project/progress@1",
  "project": "example-project",
  "updated": "2026-10-11T10:00:00+08:00",
  "tasks": {
    "T1.1": { "done": true, "doneAt": "2026-10-12", "note": "" },
    "T2.1": { "done": false }
  }
}
```

### 規則

- 每個 task 一項（absent = 未完成）。
- App 只 toggle `done`（+ 可選 `note`）。
- **Project-Manager 永遠唔寫呢個檔。**
- 完成度 = `done` tasks ÷ total tasks（現階段等權重；日後可加 weight）。

---

## 誰寫咩（單一職責）

| 檔 | 邊個寫 |
|---|---|
| `charter.md` | Project-Manager |
| `plan.json` | Project-Manager |
| `progress.json` | **人（經 app tick）** |
| `artifacts/` | 人 |

---

## 「實際進度」點計（app 用）

- **整體 %** = done tasks ÷ total。
- **per phase %**、**per owner 工作量**（幾多個 task 落喺邊個人）。
- **deliverable 到手** = task `done` 且有 `outputs`。
- **時間 vs 實際** = task 計劃 bar（`start`+`estimate_days`）對比實際 `doneAt`。

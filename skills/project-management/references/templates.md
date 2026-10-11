# Templates

直接複製去填。全部放 `wiki/projects/<project-id>/`。**工作者係人，唔係 agent。**

---

## 1. `charter.md`

```markdown
---
type: project
title: "<Project Title>"
status: active
created: YYYY-MM-DD
tags: [project, omo-project]
aliases: ["<Project Title>"]
---

# <Project Title> — Charter

## Goal
一句講清楚做完之後世界變得點。

## Success criteria
1. ...
2. ...

## Definition of Done
可判定嘅完成定義。

## Scope
- **IN**: ...
- **OUT**: ...（明確寫埋唔做咩，防 scope creep）

## Constraints
| 類 | 內容 |
|---|---|
| Time | 開工 / deadline / 每週投入 |
| Resource | 設備 / 材料 / 工具 / 場地 / 來源 |
| Procedure | 用邊個工具 / 流程 |
| Scope | 固定？變更要邊個批？ |

## Resources & Cost
### 人手（Human）
| 人 | 角色 | 技能 | 每週可用 |
|---|---|---|---|
| Jack | ... | ... | 10h |

### 資源（Resource）
| 項目 | 類型（設備/材料/工具/場地/軟件/資料） | 有冇 | 來源（已有 / 買 / 借） |
|---|---|---|---|
| ... | ... | 有 / 冇 | ... |

### 成本（Cost）
- 預算上限：HK$______　・資金來源：____（自費 / 資助 / 報銷）　・已付：HK$____

| 項目 | 單價 | 數量 | 小計 |
|---|---|---|---|
| ... | ... | ... | ... |

### 時間（Time）
- 開工 YYYY-MM-DD　・目標 YYYY-MM-DD　・每週投入 __ h

## Stakeholders (RACI)
| 人 | 角色 |
|---|---|
| Jack | CEO — approval（A） |
| Dorian | 執行（R） |

## Target
YYYY-MM-DD

## Risks（初版，詳細落 plan.json）
- ...

## Plan
詳細 WBS / 排程 / 風險 → 見同資料夾 `plan.json`。
```

---

## 2. Task（`plan.json` 內每個 task）

```json
{
  "id": "T<phase>.<n>",
  "phase": "P<phase>",
  "title": "短、動詞開頭",
  "deliverable": "具體產出（檔名 / 一句）",
  "deps": ["T...", "T..."],
  "owner": "<人嘅名，例：Jack>",
  "start": "YYYY-MM-DD",
  "estimate_days": 2,
  "acceptance": "可判定嘅完成條件",
  "outputs": ["path/to/artifact"]
}
```

> 自檢：呢個 task 係咪**一個人做得完**？`owner` 係咪一個真人？`acceptance` 係咪可以答 yes/no？

---

## 3. Risk register（`plan.json.risks`）

| id | risk | likelihood | impact | response | owner | note |
|---|---|---|---|---|---|---|
| R1 | 素材不足 | M | H | mitigate | Dorian | 先儲備 5 張 |
| R2 | Scope creep | M | H | avoid | Jack | scope 凍結，變更要批 |
| R3 | 隊友時間衝突 | M | M | mitigate | Jack | 每週 sync |

response ∈ {avoid, mitigate, transfer, accept}。

---

## 4. RACI（`charter.md` 內）

| 活動 | Jack | Dorian | 其他隊友 |
|---|---|---|---|
| Scope 批核 | A/R | C | I |
| 計劃 | A/R | C | - |
| 執行 | C | R | R |
| 驗收 | A | C | I |

R=Responsible（做）、A=Accountable（最終問責）、C=Consulted、I=Informed。

---

## 5. People / resource inventory（`plan.json.resources`）

**People（我哋有咩人）**

| name | role | 技能 / 備註 | 每週可用 |
|---|---|---|---|
| Jack | CEO | 統籌、approval | 10h |
| Dorian | 隊友 | Mech / 拍攝 | 6h |

**Sources**：wiki 檔、OneDrive 檔、MCP、本機 tools。
**Time**：每週可用鐘數、deadline。

> 盤點要**實查**（唔好靠記憶）。

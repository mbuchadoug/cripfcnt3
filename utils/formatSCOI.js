/**
 * formatSCOI.js
 * Converts the raw SCOI JSON into the Nyaradzo-style markdown.
 */

export function formatSCOI(result, entity) {
  const {
    visibility,
    contribution,
    ERF,
    adjustedSCOI,
    visibilityRationale,
    contributionRationale,
    scoiInterpretation,
    ERFRationale,
    commentary,
    urls = [],
  } = result;

  return `
## 🔷 CRIPFCnt SCOI Audit — ${entity}

---

### 1️⃣ VISIBILITY
**Score:** ${visibility?.toFixed(1) ?? "N/A"} / 10  
**Rationale:** ${visibilityRationale || "No visibility rationale provided."}

---

### 2️⃣ CONTRIBUTION
**Score:** ${contribution?.toFixed(1) ?? "N/A"} / 10  
**Rationale:** ${contributionRationale || "No contribution rationale provided."}

---

### 3️⃣ SCOI CALCULATION
**Formula:** (Contribution ÷ Visibility)  
**Result:** ${(contribution / visibility).toFixed(3)}  
**Interpretation:** ${scoiInterpretation || "No interpretation provided."}

---

### 4️⃣ ENVIRONMENTAL RESILIENCE FACTOR (ERF)
**Factor:** ${ERF?.toFixed(2) ?? "N/A"}  
**Rationale:** ${ERFRationale || "No ERF rationale provided."}

---

### 5️⃣ ADJUSTED SCOI
**Adjusted Result:** ${adjustedSCOI?.toFixed(3) ?? "N/A"}  
*(SCOI × ERF adjustment)*

---

### 6️⃣ FINAL CRIPFCNT COMMENTARY
${commentary || "No commentary available."}

---

### 🔗 SOURCES
${urls.length ? urls.map((u, i) => `${i + 1}. ${u}`).join("\n") : "_No external references found._"}
  `;
}

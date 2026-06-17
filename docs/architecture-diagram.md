# Architecture Diagram — Interface 152 Performance Test Suite

```mermaid
flowchart LR
    classDef ado    fill:#0078d4,color:#fff,stroke:#005a9e
    classDef runner fill:#5a6f85,color:#fff,stroke:#3d4f60
    classDef azure  fill:#e8f4fd,color:#003366,stroke:#0078d4
    classDef adf    fill:#e6f3e6,color:#1a3a1a,stroke:#2e7d32
    classDef store  fill:#f0f7ff,color:#003366,stroke:#50a0d8
    classDef report fill:#e8f5e9,color:#1b5e20,stroke:#43a047

    subgraph ADO["Azure DevOps"]
        CI["CI Pipeline\nPR Gate · Nightly"]
        RPT["Test Results\nJUnit XML"]
    end

    subgraph RUN["Test Runner  (CI Agent)"]
        EXEC["Scenario Execution"]
        VALID["Output Validation"]
    end

    subgraph AZ["Azure"]
        AAD["Azure AD"]
        SRC["Source Blob\nContainer"]
        ADF["Interface 152\nADF Pipeline"]
        OUT["Output Blob\nContainer (ESFX)"]
    end

    CI    -->|triggers| EXEC
    EXEC  -->|"① authenticate"| AAD
    EXEC  -->|"② upload test data"| SRC
    EXEC  -->|"③ trigger"| ADF
    EXEC  -->|"④ poll status"| ADF
    ADF   --> SRC
    ADF   -->|writes| OUT
    EXEC  --> VALID
    VALID -->|"⑤ check blob"| OUT
    VALID -->|"⑥ row counts"| ADF
    EXEC  -->|results| RPT
    VALID -->|results| RPT

    class CI,RPT ado
    class EXEC,VALID runner
    class AAD azure
    class ADF adf
    class SRC,OUT store
```

---

## Component Legend

| Colour | Component |
|---|---|
| Blue | Azure DevOps CI/CD |
| Grey | Test runner scenarios and validation |
| Light blue | Azure AD authentication |
| Sky | Azure Blob Storage (source + output) |
| Green | Azure Data Factory — Interface 152 |

## Flow Summary

| Step | Action | Assertion |
|---|---|---|
| ① | Service principal authenticates for two scopes (management + storage) | Token endpoint returns 200 |
| ② | Test runner uploads synthetic payload to source container | Blob Storage returns 201 |
| ③ | Test runner triggers Interface 152 ADF pipeline | ADF returns runId (200) |
| ④ | Test runner polls pipeline status every 10 s (max 10 min) | Terminal state reached |
| ⑤ | Output container checked for blobs written after trigger time | Blob exists, size > 0, name matches pattern |
| ⑥ | ADF activity runs queried for record counts | rowsRead > 0, rowsWritten > 0, written ≤ read |

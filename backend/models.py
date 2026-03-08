from __future__ import annotations

from typing import List, Literal, Optional

from pydantic import BaseModel, Field


class TamarindVerdict(BaseModel):
    verdict: str = "skipped"
    structural_rationale: str = ""
    compound_a: Optional[str] = None
    compound_b: Optional[str] = None
    binding_affinity_a: Optional[float] = None
    binding_affinity_b: Optional[float] = None
    confidence: float = 0.0
    tamarind_job_id: Optional[str] = None


class ClaimNode(BaseModel):
    node_id: str
    source_type: Literal[
        "private_csv",
        "public_abstract",
        "tamarind_structural",
        "pdf_document",
        "web_url",
        "youtube_video",
    ]
    source_id: Optional[str] = None
    claim_text: str
    subject_name: str
    subject_type: str
    predicate_relation: str
    polarity: Literal["promotes", "inhibits", "neutral", "ambiguous"]
    quantitative_value: Optional[float]
    quantitative_unit: Optional[str]
    object_name: str
    object_type: str
    cell_line: Optional[str]
    organism: Optional[str]
    disease_context: Optional[str]
    file_name: Optional[str]
    row_index: Optional[int]
    paper_id: Optional[str]
    sentence_id: Optional[str]
    sentence_text: Optional[str]
    citation_count: Optional[int]
    abstract_url: Optional[str]
    paper_authors: Optional[str] = None
    paper_year: Optional[int] = None
    umap_x: Optional[float] = None
    umap_y: Optional[float] = None
    friction_score: float = 0.0
    debate_state: str = "pending"
    skeptic_rationale: Optional[str] = None
    tamarind_verdict: Optional[dict] = None
    contradicting_node_ids: List[str] = Field(default_factory=list)
    ingested_at: str = ""


class Session(BaseModel):
    session_id: str
    nodes: List[ClaimNode] = Field(default_factory=list)
    debate_results: dict = Field(default_factory=dict)
    status: str = "created"
    progress: int = 0
    error_message: Optional[str] = None


class OracleRequest(BaseModel):
    session_id: str
    selected_node_ids: List[str]
    messages: List[dict]
    is_bag_query: bool = False
    bag_name: Optional[str] = None

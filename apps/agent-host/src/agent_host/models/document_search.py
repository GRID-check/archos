"""The single-collection and grouped document searches' own request and answer shapes (``routes/document_search.py``).

The grouped search's request and its filters stay in ``requests.py`` beside the
project facts and the boost they are built from.
"""

from pydantic import BaseModel
from pydantic import Field


class DocumentSearchRequest(BaseModel):
    """Request body for deterministic semantic document search within a collection."""

    query: str = Field(..., min_length=1, max_length=1000, description="Natural-language search query")
    top_k: int = Field(40, ge=1, le=100, description="Max chunks to retrieve before document-centric aggregation")
    top_k_files: int = Field(20, ge=1, le=100, description="Max documents to return after aggregation")
    snippet_max_chars: int = Field(
        300,
        ge=100,
        le=1500,
        description=(
            "Max characters kept from each document's best-matching chunk. 300 for a hit list a person scans; "
            "the cross-project lookups (ADR-0094) ask for more, because their snippet is the evidence the agent "
            "answers from and cites: it cannot open another project's document further."
        ),
    )


class DocumentSearchHit(BaseModel):
    """One document-centric search hit (a file's best-matching chunk)."""

    file_name: str = Field(..., description="Original filename of the matched document")
    score: float = Field(..., description="Similarity score (0.0 to 1.0) of the file's best-matching chunk")
    snippet: str = Field(..., description="Snippet (300 chars unless asked for more) of the best-matching chunk")
    page_number: int | None = Field(None, description="Page number of the best-matching chunk (None if N/A)")
    collection: str = Field(..., description="Collection the document belongs to")
    grid_document_id: str | None = Field(
        None, description="The BFF's id of the document, when its chunks carry it (the search joins hits by it)"
    )
    lexical: bool | None = Field(
        None,
        description=(
            "The grouped search only: whether one of the document's ranked passages holds a word of the query "
            "(the BM25 or an exact-term channel ranked it), rather than matching by meaning alone"
        ),
    )


class DocumentSearchResponse(BaseModel):
    """Response for semantic document search: document-centric hits, best score first."""

    hits: list[DocumentSearchHit] = Field(
        default_factory=list, description="Matched documents (one per file), sorted by score descending"
    )

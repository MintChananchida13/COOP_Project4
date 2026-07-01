# Qdrant Design

## Collection

```text
document_template_layouts
```

## Granularity

Each Qdrant point represents one Template Page, not a whole multi-page template.

## Payload

```text
template_id
template_page_id
template_name
document_type
category
version
page_number
status
similarity_threshold
final_confidence_threshold
created_at
updated_at
```

## Search

Use Top-K.

Default:

```text
top_k = 5
```

User detection should filter:

```text
status = approved
```

Admin Test Mode may include draft/testing pages.

## Lifecycle

If Template Page changes:
- regenerate embedding
- update Qdrant point

If Template Page deleted:
- delete Qdrant point

If Template disabled:
- filter out from user search

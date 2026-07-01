# Database Design

## templates

```text
id
name
document_type
category
status
version
page_count
similarity_threshold
final_confidence_threshold
created_by
approved_by
rejection_reason
created_at
updated_at
```

## template_pages

```text
id
template_id
page_number
page_name
sample_image_url
normalized_image_url
qdrant_point_id
similarity_threshold
final_confidence_threshold
created_at
updated_at
```

## template_fields

```text
id
template_id
template_page_id
page_number
field_name
display_label
roi_x_ratio
roi_y_ratio
roi_width_ratio
roi_height_ratio
data_type
user_selectable
default_selected
use_for_verification
expected_text
match_type
required_for_verification
extraction_method
anchor_text
regex_pattern
roi_padding
sort_order
created_at
updated_at
```

## ignore_regions

```text
id
template_id
template_page_id
page_number
field_name
roi_x_ratio
roi_y_ratio
roi_width_ratio
roi_height_ratio
created_at
updated_at
```

## template_requests

```text
id
requested_by
request_title
document_type
sample_file_url
request_mode
status
user_note
admin_note
converted_template_id
page_count
created_at
updated_at
```

## template_request_pages

```text
id
template_request_id
page_number
sample_image_url
created_at
updated_at
```

## requested_fields

```text
id
template_request_id
template_request_page_id
page_number
field_name
display_label
roi_x_ratio
roi_y_ratio
roi_width_ratio
roi_height_ratio
user_note
created_at
updated_at
```

## documents

```text
id
uploaded_by
original_file_url
status
page_count
detected_template_id
confidence_score
created_at
updated_at
```

## document_pages

```text
id
document_id
page_number
original_image_url
normalized_image_url
status
detected_template_id
detected_template_page_id
confidence_score
created_at
updated_at
```

## extraction_results

```text
id
document_id
document_page_id
page_number
template_field_id
field_name
display_label
ocr_text
ocr_confidence
roi_preview_url
created_at
```

## detection_logs

```text
id
document_id
document_page_id
page_number
candidate_template_id
candidate_template_page_id
layout_score
verification_score
final_score
decision
fail_reason
created_at
```

# Image Preprocessing

## Runs Per Page

Every page must be normalized before embedding or ROI OCR.

Steps:
- detect document boundary
- crop
- perspective correction
- deskew
- resize
- brightness normalization
- contrast normalization

## Why

Without preprocessing:
- ROI shifts
- OCR reads wrong area
- layout embedding becomes noisy
- template matching fails

## Outputs

For each document_page:

```text
normalized_image_url
normalized_width
normalized_height
```

## ROI Conversion

```text
x = roi_x_ratio * normalized_width
y = roi_y_ratio * normalized_height
width = roi_width_ratio * normalized_width
height = roi_height_ratio * normalized_height
```

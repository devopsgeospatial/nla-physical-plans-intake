# Setup: Physical Plans upload app (ArcGIS Online)

The app appends uploaded polygons to the existing layer:

`https://services7.arcgis.com/htgaiKX6RV2DDGgK/arcgis/rest/services/Physical_Plans/FeatureServer/0`

Each polygon in the uploaded file becomes one new record. File attributes whose names match the layer's fields are copied: `plan_id`, `parcel_upi`, `gen_lu`, `zone_code`, `zoning`, `planning_status`, `approval_date`, `sl`, `remarks`, `province`, `district_1`, `sector_1`, `cell_1`. Shapefile names shortened to 10 characters, such as `planning_s`, are recognised.

The app fills in:

- `created_user`: the signed-in user
- `created_date`: the upload time
- `area_sqm`: computed in the TM Rwanda grid, unless the file provides it

Geometry is projected into the layer's TM Rwanda / ITRF2005 grid. PDFs chosen with **Attachments** are attached to every new record.

## 1. Register the app (once)

1. In https://rla.maps.arcgis.com go to **Content → New item → Developer credentials → OAuth 2.0 credentials**.
2. **Redirect URL:** `http://localhost:3000/api/auth/callback`. Later, also add the production address, e.g. `https://<server>/api/auth/callback`. Leave privileges empty.
3. Copy the **Client ID** into `ARCGIS_OAUTH_CLIENT_ID` in `.env.local`.

## 2. Layer settings (layer owner)

On the `Physical_Plans` item:

- **Attachments:** go to **Overview → Layers → Physical_Plans → Enable attachments**. Until then, the app shows the Attachments button as unavailable. This doesn't change existing records.
- **Editing:** go to **Settings → Editing**. Editing must be enabled, with **Add** and **Delete** allowed. Delete is used only to undo a failed upload.
- **Who can upload:** share the layer with a group of the uploading users, and put that group's ID in `ARCGIS_ALLOWED_GROUP_ID`. Each uploader needs a user type that can edit features (Contributor, Mobile Worker or Creator).

> **Security:** the layer is currently shared **publicly with editing enabled**, so anyone can add, change or delete its records without signing in. Share it only with the uploaders' group (or the organisation), or disable editing for anonymous users. The app works without public access, because everyone signs in.

## 3. Run

```powershell
npm install
npm run dev          # http://localhost:3000 (real ArcGIS Online)
npm run dev:local    # http://localhost:3000 against a local emulator of the layer (records at http://localhost:4100)
```

1. Sign in with your ArcGIS Online account.
2. Choose the plan file (zipped Shapefile with `.prj`, or GeoJSON). The map shows the polygons; click one to see its attributes. The panel lists how many records will be appended, which attributes are copied, which are filled automatically, and which file fields are ignored.
3. Optionally add PDFs, then click **Submit**. The new object IDs are shown.

Uploads are all-or-nothing. If any record or attachment fails, the records already added by that upload are deleted again.

Samples: `samples/muhanga-parcels-tm-rwanda.zip` (3 parcels, TM Rwanda Shapefile) and `samples/muhanga-parcels-wgs84.geojson`.

## 4. Viewing the appended records in Experience Builder

1. Open the web map used by the Experience Builder app. On the `Physical_Plans` layer, go to **Properties → Refresh interval** and set **0.1 minutes**. New records then appear within about 6 seconds, with no republishing.
2. Under **Pop-ups**, add **Attachments** so the PDFs can be opened from a record. Save the map.
3. In Experience Builder, the **Map** widget shows the records. **Feature Info** or **Table** widgets show the attributes and attachments. Filter on `created_date` or `created_user` to see recent uploads.

## Troubleshooting

| Message | Fix |
|---|---|
| "Setup needed: register this app" | `ARCGIS_OAUTH_CLIENT_ID` is missing (step 1). |
| ArcGIS says `redirect_uri` is invalid | The redirect URL on the OAuth item must equal `<APP_URL>/api/auth/callback`. |
| "…does not have the Edit features privilege" | The user has a Viewer account; give them an editing user type. |
| "…is not a member of the plan submission group" | Add the user to the group in `ARCGIS_ALLOWED_GROUP_ID`, or clear that setting. |
| Attachments button unavailable | Enable attachments on the layer (step 2). |
| "Feature N, field X → …" | A value in the file doesn't fit the layer field (too long, not a number or date). Fix it in the file. |
| "…projected coordinate system" | GeoJSON must be WGS84. For other coordinate systems, upload a zipped Shapefile with its `.prj`. |
| "Your ArcGIS session has expired" | Sign in again. |

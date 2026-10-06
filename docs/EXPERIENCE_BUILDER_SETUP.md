# ArcGIS Online + Experience Builder setup

The target is ArcGIS Online (`https://rla.maps.arcgis.com`), using the current Map Viewer and Experience Builder (`https://experience.arcgis.com`).

**Layers in this setup**

| Role | Layer | Notes |
|---|---|---|
| Intake (the app writes here) | `Physical_Plan_Submissions` (created in section 2) | Review fields + PDF attachments, private to reviewers |
| Reference (read-only context) | `https://services7.arcgis.com/htgaiKX6RV2DDGgK/arcgis/rest/services/Physical_Plans/FeatureServer/0` | 3,220 existing Muhanga plan parcels. The app never writes to it. |

Both layers use the same custom grid: Transverse Mercator, CM 30°E, FE 500 000, FN 5 000 000, k 0.9999, on the ITRF2005/GRS80 datum (TM Rwanda). The API projects uploaded WGS84 boundaries into that grid locally with proj4, using the layer's own WKT.

> **Security, action needed on the reference layer.** `Physical_Plans` is shared **publicly** with editing enabled ("Public Data Collection"; Create/Update/Delete). Anyone can currently edit or delete its records without signing in. The item owner should either stop public sharing, or open **Settings → Feature layer (hosted) → Editing** and restrict editing so it isn't available to anonymous users.

---

## 1. User sign-in (each planner uses their own ArcGIS Online account)

There's no shared service account. Each of the ~30 planners clicks **Sign in with ArcGIS** and signs in on the RLA login page; SSO and MFA work as usual. The Next.js server then creates the feature with **that user's** token, so ArcGIS records who submitted each plan. Tokens are kept server-side in an encrypted, httpOnly cookie and never reach the browser's JavaScript.

### 1.1 Register the app (once, any Creator account, ~2 min)
1. **Content → New item → Developer credentials → OAuth 2.0 credentials**.
2. **Redirect URLs**: add `http://localhost:3000/api/auth/callback`. Add the production URL later, e.g. `https://plans.example.rw/api/auth/callback`.
3. Leave privileges empty, name it *Physical Plan Intake*, and save.
4. Copy the **Client ID** into `ARCGIS_OAUTH_CLIENT_ID` in `.env.local`. No client secret is needed: the app uses PKCE.

### 1.2 Who can submit
1. Create a group *Plan Submitters* and add the ~30 planners. Put its group ID (the `id=` part of the group page URL) into `ARCGIS_ALLOWED_GROUP_ID`. Anyone outside the group gets a clear "not a member" message at sign-in.
2. Each submitter needs a user type that can **edit features**: Contributor, Mobile Worker, Creator or higher. Viewer accounts are refused at sign-in with an explanatory message.
3. `SESSION_SECRET` is already generated in `.env.local`. Keep it private; changing it signs everyone out.

## 2. Feature layer

### Option A0: create it from the app (easiest; no password needed)

Sign in to the app with an account that has the **Publisher** role. If the layer in `ARCGIS_FEATURE_LAYER_URL` doesn't exist yet, the app shows **One-time setup: create the intake layer**. Click **Create Physical_Plan_Submissions** and the layer is created as you, with the same result as Option A below. It works with SSO and MFA accounts.

### Option A: provision it with the script

```powershell
# .env.local is pre-filled for rla.maps.arcgis.com; set ARCGIS_USERNAME and ARCGIS_PASSWORD first
npm run provision-layer -- --name Physical_Plan_Submissions
```

The script needs a username/password **once**: a built-in ArcGIS login (not SSO, no MFA) with Creator + Publisher. Your own account works if it fits. Put it in `ARCGIS_USERNAME`/`ARCGIS_PASSWORD` for this run, then clear them, because the running app doesn't use them. If every account in the org is SSO/MFA, use Option B instead. The script prints the org it signed into, so check that it's the RLA org before going on. It then copies the spatial reference and extent from `ARCGIS_REFERENCE_LAYER_URL` (the existing `Physical_Plans` layer). Pass `--match-sr <url>` to use a different layer.

The result is a hosted feature layer owned by the account with:

- polygon geometry in the same TM Rwanda grid as the reference layer
- attachments enabled
- dropdown lists (coded-value domains) for `district`, `plan_type` and `status`
- status colors as the default symbology

It prints `ARCGIS_FEATURE_LAYER_URL=...`. Check that it matches the value already in `.env.local`, and replace it if not. The host (`services7`) and org ID are only filled in if the account belongs to the same org as the reference layer.

### Option B: build it in the ArcGIS Online UI

1. **Content → New item → Feature layer → Define your own layer → Polygon**, then name it `Physical_Plan_Submissions`. The UI creates it in Web Mercator. That works too, because the API projects to whatever the layer uses.
2. On the item page, open **Data → Fields → Add field** and create these fields:

| Field name | Type | Length | List of values (Data → Fields → field → *Create list*) |
|---|---|---|---|
| `plan_name` | String | 255 | — |
| `district` | String | 100 | optional; the 30 district names in `lib/plan-options.ts` (Gasabo … Rwamagana) |
| `plan_type` | String | 50 | optional; `Master Plan`, `Zoning Amendment`, `Subdivision` |
| `status` | String | 20 | **recommended**: `SUBMITTED`, `UNDER_REVIEW`, `APPROVED`, `REJECTED` |
| `submission_date` | Date | — | — |
| `review_comments` | String | 4000 | — |

3. **Enable attachments**: on the item's **Overview** page, in the **Layers** section, click **Enable attachments** for the layer.

The API reads the live layer schema. A mismatch returns a clear error, for example `Server configuration error: missing field "status"` or `attachments are not enabled`.

### Item settings (both options)

On the item page, open **Settings → Feature layer (hosted)**:

- **Enable editing**: on.
- **What kind of editing is allowed?** Add, update, and delete. Delete must stay allowed, because the API deletes the feature again if a PDF upload fails.
- **Keep track of who created and last updated features**: **on** (recommended). Because each planner submits with their own token, `Creator` shows who submitted the plan and `Editor` shows the reviewer who last changed its status.
- Leave **Delete protection** off, or the item can't be cleaned up later.

**Sharing:** share the layer with the *Plan Submitters* group (they need edit access to create features) and a *Plan Reviewers* group. Don't share it publicly.

> **Before production:** anyone with edit access can, through the REST API, also change other people's features, including `status`. For the POC that's acceptable. To lock it down, turn on **"Editors can only update and delete the features they add"** (ownership-based access) on the layer. The app's rollback deletes only the user's own feature, so it keeps working. Then give reviewers status-editing rights through a separate hosted **view** layer, or the layer owner/admin role. Test the exact combination in your org. Public layers are also cached by ArcGIS Online's CDN, which would delay new submissions in the map.

**Credits:** ArcGIS Online charges credits for feature storage and attachment storage. A POC with a few PDFs costs very little.

## 3. Run the intake portal and submit a test plan

```powershell
npm run dev        # http://localhost:3000
```

1. Click **Sign in with ArcGIS**, sign in on the RLA page, and you return to the form showing your name.
2. Fill in the form and choose a `.geojson` or zipped Shapefile. The preview map draws the boundary.
3. Attach the PDF(s) and click **Submit plan**. The success panel shows the `objectId` and attachment IDs.
4. Check the result directly with these URLs (if you get a token prompt, sign in or open them from the item page):
   - `<ARCGIS_FEATURE_LAYER_URL>/query?where=1%3D1&outFields=*&orderByFields=objectid+DESC&f=html`
   - `<ARCGIS_FEATURE_LAYER_URL>/<objectId>/attachments?f=html`

   You can also open the item's **Data** tab to see the row.

## 4. Web map (symbology, pop-ups, auto-refresh)

1. Click **Open in Map Viewer** from the `Physical_Plan_Submissions` item. Then **Add → Browse layers → ArcGIS Online** (or *My organization*), add the reference `Physical_Plans` layer, and drag it **below** the submissions layer. Give it a neutral grey style and disable its pop-ups if reviewers don't need them.
2. **Symbology by status**: select the layer and open **Styles**.
   1. Choose attributes: **`status`**, then **Types (unique symbols)** → **Style options**.
   2. Set the colors:
      - `SUBMITTED`: orange `#F59E0B`
      - `UNDER_REVIEW`: blue `#2563EB`
      - `APPROVED`: green `#16A34A`
      - `REJECTED`: red `#DC2626`
   3. Set fill transparency to about 60% and outline width to 2 px.

   Option A already stores this as the default style, so you only need to confirm it here.
3. **Pop-ups**: enable them. Title: `{plan_name}`.
   1. **Fields list**: `plan_name`, `district`, `plan_type`, `status`, `submission_date`, `review_comments`.
   2. **+ Add content → Attachments**, display as **List**. This makes the PDFs clickable.
4. **Live updates**: open **Properties → Refresh interval**, turn it on, and set **0.1 minutes** (6 s).
5. **Save as** *Plan Review Map* and share it with the *Plan Reviewers* group.

## 5. Experience Builder review app

From the app launcher, open **Experience Builder** (or go to `https://experience.arcgis.com`). Click **Create new** and choose **Blank fullscreen** (or *Foldable*).

### 5.1 Map widget
1. Drag a **Map** widget onto the page.
2. **Select map → Add new data**, pick *Plan Review Map*, then **Done**.
3. Under **Tools**, enable Zoom, Home, Search, Layer list (optional) and **Select**.
4. Turn on **Feature selection**.

### 5.2 Feature Info widget (attributes + PDF)
1. Add a **Feature Info** widget in a sidebar.
2. **Source: Interact with a Map widget**, then pick **Map**.
3. Make sure the `Physical_Plan_Submissions` layer is selected and attachments are displayed.

Clicking a polygon now shows its attributes and the PDF link(s). PDFs open in the browser.

### 5.3 Edit widget (approve or reject with comments)
1. Add an **Edit** widget, either in the sidebar or in a Widget Controller.
2. Choose **Map mode** and select **Map**.
3. In the layer list, enable **only** `Physical_Plan_Submissions` (leave the reference layer off) and set:
   - **Update attributes**: on.
   - **Update geometry**: off. The submitted boundary is the record of submission.
   - **Add / Delete**: off.
   - **Attachments**: on, if you want reviewers to see or add files in the edit form.
4. Under **Fields**, keep only `status` and `review_comments` editable. Make the others read-only or hidden.

Because `status` has a list of values, reviewers pick from a dropdown. When they click **Update**, the polygon changes color at once.

### 5.4 Optional queue tools
- **Table** widget on the layer, with the filter `status = 'SUBMITTED'`, sorted by `submission_date` descending.
- **Filter** widget with the clause *Status is (ask for value)*.

### 5.5 Publish
**Save → Publish**, then share the app with the *Plan Reviewers* group.

You publish once. Every new submission is a new row in the live layer, so the app shows it without republishing.

## 6. End-to-end test

1. Open the published app (`https://experience.arcgis.com/experience/<id>`).
2. Submit a plan from `http://localhost:3000`. Within about 6 s an **orange** polygon appears.
3. Click it. Feature Info shows the attributes and the PDF.
4. In Edit, set `status = APPROVED`, add a comment, and click **Update**. The polygon turns **green**.

## 7. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| ArcGIS login page says `redirect_uri` is invalid | The redirect URL on the OAuth credentials item must exactly equal `<APP_URL>/api/auth/callback`. |
| `Invalid client_id` on the login page | `ARCGIS_OAUTH_CLIENT_ID` is wrong, or the credentials item was deleted. |
| "…is not a member of the plan submission group" | Add the user to *Plan Submitters*, or clear `ARCGIS_ALLOWED_GROUP_ID`. |
| "…does not have the Edit features privilege" | The user has a Viewer type. Assign Contributor / Mobile Worker / Creator. |
| "Your ArcGIS account does not have edit access to the plan submissions layer" | The layer isn't shared with that user's group, or editing/Add is disabled (section 2). |
| "Your ArcGIS session has expired" | The refresh token expired (`SESSION_MINUTES`, max 2 weeks) or was revoked. Sign in again. |
| `Server configuration error: attachments are not enabled` | Overview → Layers → **Enable attachments**. |
| `... is not a valid code in the "status" domain` | The layer's list values differ from `lib/plan-options.ts`. Make them identical. |
| Boundary rejected as "outside WGS84 range" | The GeoJSON is in a projected CRS. Export it as EPSG:4326, or upload a zipped Shapefile **with its .prj**. |
| Plan is stored but doesn't appear in EB | Check that the refresh interval is set on the **web map** layer, the layer isn't shared publicly (CDN caching), and there is no layer filter. Reload the app. |
| `provision-layer` fails with `Unable to generate token` | That account is SSO/MFA. Use another built-in account, or create the layer with Option B. |

# Physical Plans – maintenance notes

How the system fits together and how to make and publish small changes yourself.
Last updated 11 October 2026.

---

## 1. What runs where

One codebase (this folder) runs as **four apps**. Each is its own project on Vercel. A
project's settings decide which app it is (`APP_MODE`) and which ArcGIS layers it uses.

| App | Who uses it | Live address | `APP_MODE` | `npm run deploy` name |
|---|---|---|---|---|
| Landing page | Everyone | https://nla-physical-plans-home.vercel.app | `home` | `landing` |
| Physical Plan Submission | District planners (sign in) | https://nla-physical-plans.vercel.app | `submission` | `submission` |
| Physical Plan Review | NLA reviewers (sign in) | https://nla-physical-plans-review.vercel.app | `review` | `review` |
| Physical Plans Map | Citizens (no sign-in) | https://nla-physical-plans-public.vercel.app | `public` | `public` |

**The pipeline:**
1. A planner uploads a plan, which is appended to the editable layer.
2. NLA approves it (sets `approval_date`) or returns it with a comment (`remarks`).
3. Approved plans appear on the public map through the public view. That map's figures are
   cached for up to 5 minutes.

**Accounts and places**

| What | Where |
|---|---|
| Code | GitHub: https://github.com/devopsgeospatial/nla-physical-plans-intake (branch `main`) |
| Live apps | Vercel account `gilbert-uwonkunda`, projects `nla-physical-plans`, `nla-physical-plans-review`, `nla-physical-plans-public`, `nla-physical-plans-home` |
| Data and sign-in | ArcGIS Online: https://rla.maps.arcgis.com |

**ArcGIS items the apps use**

| Item | Address / ID | Used by |
|---|---|---|
| Editable plans layer (private) | `…/Rwanda_Physical_Plans/FeatureServer/0` | Submission, Review |
| Public view of it (read-only) | `…/Rwanda_Physical_Plans_view/FeatureServer/0` | Public map, Landing |
| Site plan boundaries | `…/Phyisical_Plan_Muhanga/FeatureServer/4` | Public map |
| District boundaries | `…/District_boundary_eca06/FeatureServer/0` | Public map, Landing |
| Muhanga parcel register (UPIs) | `…/Muhanga_Parcels/FeatureServer/0` | Public map (UPI search) |
| Web map behind Submission/Review | `04d76651f4a046f7be88c7d072780f19` ("Physical Plans Map") | Submission, Review |
| Web map behind the public map | `83361399512f417580bd31a1d855be89` ("Physical Plan Map") | Public map |

All addresses start with `https://services7.arcgis.com/htgaiKX6RV2DDGgK/arcgis/rest/services/`.

---

## 2. Setting up a computer (once)

1. Install **Node.js 22 or newer** (https://nodejs.org) and **Git**.
2. Get the code: `git clone https://github.com/devopsgeospatial/nla-physical-plans-intake.git`, or use
   this folder.
3. In the folder: `npm install`
4. Sign in to Vercel once: `npx vercel login` (account `gilbert-uwonkunda`).
5. Optional, only for running against the real ArcGIS: copy `.env.example` to `.env.local` and fill it
   in. Every setting is explained in `.env.example`. **Never** commit or share `.env.local`, because it
   holds secrets.

---

## 3. The everyday routine for a change

```powershell
# 1. Change the code (see section 4 for where things live).

# 2. Look at it on your computer (section 5).

# 3. Check nothing broke. Both must end with "fail 0".
npm test
npm run test:e2e

# 4. Save it on GitHub
git add -A
git commit -m "Short description of the change"
git push origin main

# 5. Update the live apps. Pick only the apps your change affects, or none to deploy all four.
npm run deploy -- public
npm run deploy -- submission review
npm run deploy
```

- Each app takes about 2 minutes to deploy. The command ends with `OK` or `FAILED` for each app.
- **GitHub and Vercel are separate.** Pushing to GitHub does *not* change the live apps; only
  `npm run deploy` does.
- If `git push` fails with "Connection was reset", the network is blocking github.com. Try another
  network or a phone hotspot.
- **Undo a bad release:** in Vercel, open the project → **Deployments** → choose the previous good one →
  **⋯ → Promote to Production**. This takes seconds and needs no code.

---

## 4. Where to change common things

| You want to change… | File |
|---|---|
| Landing page wording, buttons, sections | `components/Landing.tsx` |
| Landing hero picture / app screenshot | `public/planned-settlement.jpg`, `public/landing-app.jpg` (replace the file, keep the name) |
| NLA logo | `public/nla-logo.png` |
| Font | `lib/fonts.ts` (one font for all apps) |
| Colours of Submission and Review | the colour list at the top of `app/globals.css` (`--color-nla`, `--color-ink`, …) |
| Colours of the public map | the `#` colour codes in `components/public/*.tsx` |
| Public map panels (Insights, Explore, Documents, Download, Legend, Layers, Basemaps) | `components/public/Panels.tsx` |
| Public map search result card | `components/public/ParcelResult.tsx` |
| Public map header and side rail | `components/public/PublicApp.tsx` |
| The five plan stages: names, short names, colours, keywords | `lib/public/stages.ts` |
| Districts list, provinces, district reports, Zoning Regulations link | `lib/public/districts.ts` |
| Connect a district's parcel register (for UPI search) | `lib/public/districts.ts`, the `LIVE` list (see 6.3) |
| Upload screen (planners) | `components/UploadWorkspace.tsx` |
| "My submissions" screen (planners) | `components/SubmissionsView.tsx` |
| Review screen (NLA) | `components/ReviewWorkspace.tsx` |
| Status labels ("Waiting for NLA", "Returned for changes", …) | `components/StatusTag.tsx` |
| Sign-in screen | `app/page.tsx` (`SignIn`, `HubScreen`) |
| Fields shown when clicking a parcel (planner/reviewer maps) | `app/api/plans/mine/parcels/route.ts`, `POPUP_FIELDS` |
| Rules for approve / return | `lib/plans/review.ts` |
| Rules for appending uploads (duplicates, repair, attachments) | `lib/plans/append-features.ts` |

Wording is plain text in these files. Search for the sentence you see on screen (in VS Code:
**Ctrl+Shift+F**) to find where it lives.

---

## 5. Looking at a change on your computer before publishing

**Submission or review app, with test data (no real ArcGIS needed):**
```powershell
npm run dev:local            # submission app at http://localhost:3000, sign in as planner.muhanga / rla-test
npm run dev:local -- review  # review app,     sign in as reviewer.nla / rla-test
```
This uses a built-in stand-in for ArcGIS (`scripts/dev/arcgis-emulator.ts`), so nothing reaches the
real layer. The records you create are lost when you stop it (Ctrl+C).

**Landing page or public map, with the real (public) data:**
```powershell
$env:APP_MODE = "home";   npm run dev   # landing page at http://localhost:3000
$env:APP_MODE = "public"; npm run dev   # public map at http://localhost:3000/muhanga
Remove-Item Env:APP_MODE                 # afterwards
```

Changes to the code appear in the browser as soon as you save the file.

---

## 6. Changes that need no code (settings and ArcGIS)

### 6.1 Change a setting of a live app
In Vercel, open the project → **Settings → Environment Variables** → edit the value → then redeploy that
app (`npm run deploy -- <name>`). Settings only take effect after a deploy. All settings are described
in `.env.example`.

The ones you are most likely to touch:

| Setting | Projects | Meaning |
|---|---|---|
| `ARCGIS_FEATURE_LAYER_URL` | submission, review | The editable plans layer |
| `PUBLIC_PLAN_LAYER_URL` | public, landing | The public view of it (defaults to `Rwanda_Physical_Plans_view`) |
| `PUBLIC_SITES_LAYER_URLS` | public | Site-plan layers, comma-separated |
| `ARCGIS_WEBMAP_ID` / `PUBLIC_WEBMAP_ID` | submission+review / public | Which web map is shown |
| `ARCGIS_REVIEWER_GROUP_ID` | review | ArcGIS group whose members may review |
| `ARCGIS_ALLOWED_GROUP_ID` | submission | ArcGIS group whose members may submit (empty = any user with edit rights) |
| `MAX_PDF_COUNT`, `MAX_PDF_BYTES` | submission | PDF limits per upload |

### 6.2 Add a new site plan
- **Site in an existing site layer:** draw or import the boundary, fill in `site_name` and `site_stage`.
  Nothing else to do.
- **New site layer:** share it publicly. Add its address to `PUBLIC_SITES_LAYER_URLS` on the public
  project (comma-separated), then run `npm run deploy -- public`.
- **Stage values:** `site_stage` accepts the stage name, a keyword ("draft review", "gazettement") or a
  number 1–5. Stages 1–4 count as *Ongoing*, stage 5 as *Completed*.
- **Missing name:** a site without `site_name` is named after its layer.

### 6.3 Connect another district's parcel register (UPI search for every parcel)
A district appears on the map by itself as soon as NLA approves a plan there. Until its parcel register
is connected, citizens can only search the UPIs of planned parcels. To connect one (e.g. Huye):
1. Make sure the parcel layer is shared publicly and has a `upi` field.
2. In `lib/public/districts.ts`, add a line to `LIVE`, next to Muhanga's:
   ```ts
   Huye: { parcelsLayerUrl: `${PARCELS}/Huye_Parcels/FeatureServer/0`, upiField: "upi" },
   ```
3. Test, push and deploy `public` and `landing` (section 3).

### 6.4 Things in ArcGIS Online that the apps depend on
- **Rwanda_Physical_Plans** (the editable layer):
  - **Editing on** (add, update, delete) and **attachments on**. If editing is off, submits fail with
    "Editing is turned off…".
  - **Not** shared with Everyone.
- **Rwanda_Physical_Plans_view** (the public view): shared with **Everyone**, read-only, attachments on.
- **The public web map:** shared with Everyone. It should hold the **view**, not the editable layer.
- **Don't rename these fields:** `approval_date`/`approval_d`, `remarks`, `created_user`/`created_us`,
  `created_date`/`created_da`, `parcel_upi`, `area_sqm`, `district_1`, `cell_1`, and on site layers
  `site_name`, `site_stage`. The apps accept a full name or its 10-character shapefile cut.
- **Attachment keywords:** PDFs a planner uploads are tagged `planner-submission`, and NLA's are tagged
  `nla-review`. That tag is how the apps tell "your documents" from "documents from NLA".

---

## 7. When something goes wrong

**See the error behind a failure:** the browser only says "500" or "422". The real reason is in the
server log:
```powershell
npx vercel logs nla-physical-plans.vercel.app --since 2h
```
Replace `nla-physical-plans` with `nla-physical-plans-review`, `-public` or `-home` for the other apps.
The same logs are in Vercel → project → **Logs**.

| Symptom | Usual cause | Fix |
|---|---|---|
| Submit says "Editing is turned off…" (422) | Editing switched off on the editable layer | ArcGIS Online → layer → Settings → Editing → on |
| Submit fails with PDFs only | Attachments off on the editable layer | Settings → Attachments → on |
| Log shows "Token Required" (499) | An app reads a layer that is not public | Point the app at the public view, or share the layer |
| Log shows "Invalid Token" (498) on `utility.arcgisonline.com` | A geometry-service call (it refuses planners' tokens) | Usually a new coordinate system: tell a developer the layer's WKID |
| New approval not on the public map | Up to 5-minute cache | Wait 5 minutes and reload |
| A district missing from the landing menu | No approved plan inside its boundary yet | Approve one in the review app |
| Sign-in loops inside Experience Builder | Browser blocking cookies in frames | Use username/password, or "Open in a new tab" |
| Console: "Register a service worker", "sandbox…", "Slow network…" | Experience Builder / Chrome notices | Harmless, ignore |

---

## 8. Good habits

- Run `npm test` and `npm run test:e2e` before every deploy. They take about 2 minutes and catch most
  mistakes.
- Deploy only the apps you changed, and check them in the browser right after.
- Keep secrets (`SESSION_SECRET`, OAuth client ID, passwords) only in Vercel settings and your
  `.env.local`, never in the code.
- Change one thing at a time. If something breaks, roll back the deployment in Vercel (section 3) and
  look at the log.
- For larger changes (new features, new layers with a different structure, hosting on NLA's server),
  the project also has a `Dockerfile` for running the apps on NLA's own server.

# Maktabah

A personal, offline-first Islamic study library. Mobile-first, no backend, no account. All data (PDFs, extracted text, notes, aqwal) is stored in the browser's IndexedDB on your own device.

## Tabs

1. **Vault**: Obsidian-style markdown notes with `[[wikilinks]]` between notes, autosave, and preview mode.
2. **Library**: upload book PDFs. Text is extracted page by page on-device (pdf.js). The search bar searches ALL uploaded books plus your notes plus your aqwal. Book results show the page number and tapping one opens the PDF at that exact page. Arabic search ignores harakat and unifies alif/ya/ta marbuta forms.
3. **Books**: three lists - Currently studying, Completed, and Future (in sha Allah). Add books manually or press "Track in My Books" on an uploaded PDF. Move books between lists with one tap.
4. **Aqwal**: save ahadith of the Nabi (saws), aqwal of the salaf, or ayat, with source attribution and a "To memorize" flag. Filterable.

## Run locally

Any static server works:

```
npx http-server C:/Users/mrmra/projects/maktabah -p 8137
```

Then open http://localhost:8137

## Use on your phone

Host the folder anywhere static (free options: GitHub Pages, Netlify Drop, Cloudflare Pages), open the URL in your phone browser, then "Add to Home Screen" to install it like an app. PDFs you upload on the phone stay on the phone (IndexedDB), so upload your books from the device you study on.

## Notes and limits

- Scanned/image-only PDFs have no text layer, so they store and open fine but are not searchable (would need OCR).
- pdf.js is loaded from a CDN, so first load needs internet; everything else is local.
- Clearing browser site data deletes your library, so avoid "clear browsing data" for this site.

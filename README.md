# Reading Log

A small web app for logging the books you read on your iPad. It works offline once it's installed. Your log is stored on the iPad, and you back it up to iCloud Drive as a CSV file.

## 1. Put it online (one time, about 5 minutes)

A Home Screen app has to be served over HTTPS. GitHub Pages does this for free.

1. Sign in at github.com (or create a free account).
2. Create a new repository called `reading-log`. Public is fine: the app holds no data, because your books stay on your iPad.
3. Click **Add file › Upload files** and drag in **everything inside this folder** (index.html, app.js, the `icons`, `fonts` and `vendor` folders, and the rest). Click **Commit changes**.
4. Go to **Settings › Pages**. Under "Build and deployment", choose **Deploy from a branch**, pick **main** and **/ (root)**, then click **Save**.
5. After a minute your app is live at `https://<your-username>.github.io/reading-log/`.

Netlify works too: sign in at app.netlify.com, choose **Add new site › Deploy manually**, and drag this folder onto the page.

## 2. Install it on the iPad

1. Open the address above in **Safari** on the iPad.
2. Tap the **Share** button, then **Add to Home Screen**.
3. **Open the app from the Home Screen icon from now on.** Home Screen apps keep their own storage, separate from Safari tabs. Anything you add in a Safari tab won't appear in the app.

## 3. Bring in your history

1. Save `reading-log.csv` (sent alongside this app) into iCloud Drive, for example in a folder called **Reading Log**.
2. In the app, tap **Import a CSV** (or go to **Backup › Replace everything**) and pick that file.
3. Go to **Backup › Find covers** to fetch covers and page counts for your older books. This takes about 4 to 5 minutes for 244 books. If a cover is wrong, open the book, tap **Edit**, then **Choose another cover** or **Use a photo**.

## Backing up to iCloud

iPadOS doesn't let web apps write files on their own, so a backup takes one tap from you:

**Backup › Back up now › Save to Files › iCloud Drive › Reading Log › Save** (choose **Replace**).

A red dot on the Backup tab, and a banner on the shelf, show when books have changed since your last backup. To restore on a new iPad, install the app and use **Replace everything** with your latest `reading-log.csv`.

## The CSV file

| Column | Meaning |
|---|---|
| id | Internal ID. Keep it as it is so that merges match books correctly |
| title, author, isbn | |
| format | `Physical`, `Kindle`, `Audiobook`, or a combination such as `Physical/Kindle` |
| started, finished | `YYYY-MM-DD`. Older entries may have only `YYYY-MM`. An empty `finished` means you're still reading it |
| pages, publisher, published | From the lookup. `published` is the year |
| cover_url | Link to the cover image, or an embedded photo |
| added, updated | When the entry was created or last changed |

The file opens in Numbers and Excel. If you edit it there, import it again with **Import and merge**.

## Updating the app

If you change any files, bump `VERSION` at the top of `sw.js` before you upload them. The app will then offer a **Reload** the next time it opens.

## Credits

Book details come from Open Library and Google Books. Barcode scanning uses ZXing (Apache 2.0). Fonts: Literata and Hanken Grotesk (SIL Open Font License).

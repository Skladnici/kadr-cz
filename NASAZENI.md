# Nasazení KADR.CZ — návod bez příkazové řádky

Cíl: po dokončení bude fungovat jedna webová adresa (odkaz), kterou lidé
otevřou v prohlížeči a rovnou používají. Nic se neinstaluje na počítač,
vše se nastavuje kliknutím na webu. Celkem cca 20–30 minut.

Postup má dva kroky: nejprve nahrát projekt na GitHub (jen jako úložiště
souborů), pak ho připojit ke dvěma bezplatným službám, které ho samy
"postaví" a zveřejní.

---

## Krok 1 — Založit účet na GitHubu (5 min)

1. Jděte na [github.com](https://github.com) → **Sign up** → vytvořte si účet
   (e-mail + heslo, zdarma).
2. Po přihlášení klikněte vpravo nahoře na **+** → **New repository**.
3. Název repozitáře: `kadr-cz` (nebo cokoliv). Ponechte **Public** nebo
   **Private** (obojí funguje). Klikněte **Create repository**.
4. Na stránce repozitáře klikněte **uploading an existing file** (odkaz
   uprostřed stránky).
5. Rozbalte staženou složku `hr-simple` na počítači. Přetáhněte myší
   **celý obsah složky `hr-simple`** (tedy `backend`, `frontend`, `README.md`
   — ne samotnou složku `hr-simple`, ale to, co je uvnitř) do okna prohlížeče.
6. Dole klikněte **Commit changes**.

Máte hotovo — projekt je teď na GitHubu.

---

## Krok 2 — Nasadit backend (server) na Render (10 min)

Render je bezplatná služba, která spustí server nastálo, na vlastní adrese.

1. Jděte na [render.com](https://render.com) → **Get Started** → nejjednodušší
   je zaregistrovat se přes **GitHub** (tlačítko "Sign up with GitHub") —
   propojí se to automaticky s účtem z kroku 1.
2. V Render nahoře klikněte **New +** → **Web Service**.
3. Vyberte repozitář `kadr-cz`, který jste vytvořili v kroku 1.
4. V nastavení:
   - **Name**: `kadr-cz-backend` (nebo libovolně)
   - **Root Directory**: `backend`
   - Render sám rozpozná soubor `Dockerfile` a nastaví zbytek automaticky
   - **Instance Type**: **Free**
5. Dole klikněte **Create Web Service**. Render začne stavět server —
   trvá to 3–5 minut, uvidíte průběh v okně s logy.
6. Až skončí (nahoře se objeví zelené kolečko a "Live"), zkopírujte adresu
   serveru — je nahoře na stránce, vypadá takto:
   `https://kadr-cz-backend.onrender.com`

   **Tuto adresu si uložte** — bude potřeba v kroku 3.

> Poznámka: na bezplatném plánu Render server "usne", pokud ho 15 minut
> nikdo nepoužívá, a první požadavek po probuzení trvá cca 30–60 sekund.
> Pro plynulý provoz bez čekání stačí přejít na placený plán (cca 7 USD/měsíc)
> v nastavení služby — tlačítko "Upgrade".

---

## Krok 3 — Vložit adresu backendu a nasadit frontend (webovou stránku) na Vercel (10 min)

1. V GitHubu otevřete repozitář `kadr-cz` → jděte do složky `frontend` →
   otevřete soubor `index.html` → klikněte na tužku (ikona **Edit**, vpravo
   nahoře nad textem souboru).
2. Najděte řádek:
   ```
   window.__HR_API_BASE__ = "https://YOUR-BACKEND-URL.onrender.com";
   ```
   a nahraďte `https://YOUR-BACKEND-URL.onrender.com` adresou, kterou jste
   zkopírovali v kroku 2 (mezi uvozovkami zůstane jen ta nová adresa).
3. Dole klikněte **Commit changes**.
4. Jděte na [vercel.com](https://vercel.com) → **Sign Up** → opět zvolte
   **Continue with GitHub**.
5. Klikněte **Add New...** → **Project**.
6. Vyberte repozitář `kadr-cz` → **Import**.
7. V nastavení projektu:
   - **Root Directory**: klikněte **Edit** vedle a vyberte `frontend`
   - Ostatní pole (Framework Preset: Vite) Vercel rozpozná sám
8. Klikněte **Deploy**. Za cca 1–2 minuty je hotovo.
9. Vercel ukáže veřejnou adresu, např. `https://kadr-cz.vercel.app`.

**Tohle je ten odkaz, který lidé v kanceláři otevřou a rovnou používají.**
Můžete si ho uložit jako záložku nebo poslat kolegům.

---

## Co dělat, když se něco pokazí

- **Frontend se otevře, ale po nahrání dokumentu vypíše chybu o serveru**
  → adresa backendu v `index.html` (krok 3, bod 2) je špatně opsaná,
  nebo backend na Render ještě "spí" (počkejte 30–60 s a zkuste znovu).
- **Render build selže** → v logu bude napsáno proč; nejčastěji chybí
  správně nastavený "Root Directory: backend" (krok 2, bod 4).
- **Chcete zapnout skutečné AI rozpoznávání dokladů místo ukázkových dat**
  → v Render, v nastavení služby → záložka **Environment** → přidejte
  proměnnou `GOOGLE_VISION_API_KEY` s hodnotou vašeho klíče (návod na
  jeho získání je v hlavním `README.md`) → Render se sám restartuje.

---

## Shrnutí, co kde běží

| Co | Kde | Odkaz slouží pro |
|---|---|---|
| Backend (rozpoznávání, generování Wordu) | Render.com | interní, není potřeba ho otevírat ručně |
| Frontend (webová stránka) | Vercel.com | **toto je odkaz pro zaměstnance** |

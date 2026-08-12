# Archiv workflow souborů

Tyhle soubory nejsou v `.github/workflows/`, takže je GitHub Actions
nevidí a nikdy je nespustí (ani manuálně, ani plánovaně) — jsou tu jen
pro historii/referenci.

Přesunuto sem 2026-08-12 v rámci bezpečnostního auditu: jednorázové
debug/export/find/fix/verify skripty z incident-response práce na
konci července a začátku srpna 2026 (rozpad brand discount capů,
coupon fields synchronizace). Všechny naposledy běžely 3.–6. 8. 2026,
účel splnily, a dál jen zbytečně zvětšovaly seznam workflow tlačítek
na GitHubu (riziko omylem kliknout na nesprávné).

`sync-guest-coupon-cap.yml` byl archivován záměrně jako jediný s
**opravdu rozbitou logikou** — 5. 8. 2026 přepsal max. slevy na
14 606 produktech (viz commit historie souboru). Cron už byl dřív
vypnutý, ale skript samotný nebyl nikdy opravený — archivace ho navíc
znepřístupní i pro omylné manuální spuštění.

Potřebuješ některý z nich znovu použít? Přesuň ho zpátky do
`.github/workflows/` (`git mv .github/workflows-archive/soubor.yml
.github/workflows/`) — nic se nesmazalo, jen se přestal automaticky
nabízet.

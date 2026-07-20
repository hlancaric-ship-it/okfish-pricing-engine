# Changelog

Veškeré významné změny v tomto projektu budou dokumentovány v tomto souboru.

## [1.0.0] - 2026-07-20

### Architektura
- Kompletní migrace z ukládání do FTP JSON souborů na bezstavový Cloudflare Worker a KV úložiště.
- **Blue-Green Deployment**: Implementována robustní importní logika chránící data před poškozením během importu, včetně vlastního Garbage Collectoru pro smazané zákazníky.
- Paměťová cache s 60sekundovou expirací ve Workeru pro redukci KV čtení a vyšší výkonnost pro koncové zákazníky.
- Monitorovací health check API pro rychlou kontrolu stavu importu dat a metriky.
- Kratší URL endpointy s nativní podporou ETags.

## [1.0.0-RC1] - 2026-07-19

### Přidáno
- Automatické generování VIP ceníků ze zákaznických dat.
- Výpočet zákaznických cen (přidělení do tiers ZR4 - ZR25 na základě obratu).
- Frontend komponenta pro zobrazení VIP ceny (přeškrtnutí původní ceny a zvýraznění nové s odznakem).
- SHA-256 hash lookup (rozdělený do 256 podsložek pro optimalizaci FTP přenosů a dokonalou ochranu soukromí e-mailů).
- Diagnostický režim (`VIP_DEBUG`) ve frontendu pro snazší debugging u konkrétních zákazníků.
- Automatické generování metadat (čas importu, počet zákazníků, verze) do JSON souborů.

### Změněno
- Oddělena generovací logika (Node.js backend) od prezentační vrstvy (frontend JS běžící v Shoptetu).
- Přechod od manuálního udržování a upravování zákazníků k plně skriptovanému exportu z čistých dat.

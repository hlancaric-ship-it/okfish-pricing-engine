# Cenový engine pro Shoptet e-shopy — prehľad pre obchodníkov

## Aký problém to rieši

Shoptet vie ponúkať zľavy — vernostné úrovne pre stálych zákazníkov, kupóny,
výpredajové ceny. Problém nastáva vo chvíli, keď sa tieto zľavy majú
kombinovať naraz. Shoptet sám o sebe nemá rozumný spôsob, ako povedať:
"tento zákazník má vernostnú zľavu 20 %, produkt je navyše vo výpredaji,
akú cenu má teda vidieť — a smie si k tomu ešte uplatniť kupón?" Bez
dodatočnej logiky sa zľavy buď jednoducho sčítajú (čo môže produkt predať
pod nákupnú cenu), alebo sa naopak vzájomne prebijú nesprávnym spôsobom —
napríklad sa výpredajová cena "opraví" nahor len preto, že vznikla nová
zľavová hranica pre danú kategóriu, hoci obchodník chcel, aby výpredajová
cena platila.

Tento engine je nadstavba, ktorá presne definuje **poradie, v akom sa zľavy
uplatňujú**, a zaisťuje, že sa nikdy nestane niečo, čo obchodník nechcel —
napríklad že sa produkt predá s príliš vysokou zľavou, alebo že si zákazník
uplatní kupón tam, kde by nemal.

Bol postavený ako riešenie na mieru pre konkrétny e-shop — **okfish.sk**
(rybárske potreby) — a slúži tu ako konkrétny príklad toho, ako to funguje
v praxi.

## Ako to funguje v praxi

**Presné poradie zliav.** Systém má jasne definované pravidlá, čo má
prednosť: napríklad výpredajová cena produktu má prednosť pred stropom
zľavy danej kategórie alebo značky, ale strop zľavy zase môže obmedziť, aká
hlboká vernostná zľava sa smie uplatniť. Toto poradie sa dá pre každého
klienta nastaviť inak — počet vernostných úrovní, ich percentá, ktoré
značky alebo kategórie majú vlastný strop zľavy, to všetko je
konfigurovateľné, nie napevno zadrôtované v kóde.

**Kupóny majú vlastnú politiku.** Kupón sa neuplatní automaticky na
akúkoľvek zľavnenú cenu. Systém si spočíta, koľko "priestoru" ešte zostáva
do dohodnutého stropu (napríklad 20 % z pôvodnej ceny) a kupón môže pokryť
maximálne tento zvyšok. Zákazníci na najvyšších vernostných úrovniach môžu
mať kupóny úplne zablokované, pretože už majú maximálnu zľavu, na akú majú
nárok — to je business rozhodnutie, ktoré si každý klient nastavuje sám.

**Ceny sa synchronizujú priebežne, nie ručne.** Ceny, zľavové polia a
kupónové limity sa automaticky prepočítavajú a zapisujú do Shoptetu na
základe pravidelného harmonogramu (rádovo každých 15 minút) a tiež okamžite
pri zmene produktu cez webhook. Obchodník teda nemusí ručne prepočítavať
zľavy pri každej zmene katalógu, akcie alebo cenníka.

**Bezpečnostné poistky proti "splašeným" cenám.** Keď vstupný dátový feed
(zdroj produktových dát) obsahuje chybu — napríklad sa pokazí formát alebo
sa nečakane zmení príliš veľká časť katalógu naraz — systém takú
synchronizáciu **odmietne vykonať naživo** a radšej upozorní, než aby
potichu prepísal ceny stoviek alebo tisícov produktov nesprávnou hodnotou.
Toto je jedna z najdôležitejších vlastností: engine je navrhnutý tak, aby v
prípade pochybností radšej nič nezmenil, než aby spravil plošnú chybu.

**Administrácia bez zásahu do kódu.** Business pravidlá (percentá zliav,
ktoré vernostné úrovne majú kupóny zablokované, ktoré značky alebo produkty
majú kupóny vypnuté, dočasné výpredajové okná) sa dajú meniť cez
konfiguračný súbor a jednoduchú desktopovú aplikáciu, bez toho, aby bolo
nutné zasahovať do programátorského kódu alebo čakať na nasadenie novej
verzie. Zmena sa prejaví pri najbližšom automatickom behu synchronizácie.

**Zobrazenie na webe.** Na samotnom e-shope sa zákazníkovi zobrazuje jeho
skutočná zľava (vernostná + prípadná akciová + kupón) priamo v košíku a v
katalógu, aby videl reálnu cenu ešte pred objednávkou, nie až pri pokladni.

## Príklad z praxe: okfish.sk

Na okfish.sk má obchodník desať vernostných úrovní zákazníkov s rôznou
hĺbkou zľavy. K tomu bežia pravidelné výpredaje konkrétnych produktov a
stropy zliav podľa značky alebo kategórie. Bez tohto systému by kombinácia
"zákazník na vysokej vernostnej úrovni + produkt vo výpredaji + platný
kupón" mohla viesť k tomu, že produkt sa predá hlboko pod zamýšľanú cenu —
alebo naopak, že sa výpredajová akcia zákazníkovi vôbec neprejaví, pretože
ju "prebije" iné pravidlo.

Počas prevádzky sa skutočne objavila chyba presne tohto typu: výpredajová
cena jedného produktu sa pri nastavení nového stropu zľavy pre danú
kategóriu omylom zvýšila naspäť, namiesto toho aby výpredajová cena zostala
v platnosti. Chyba bola nájdená, opravená a odvtedy je automaticky
kontrolovaná pri každej zmene, aby sa nemohla nepozorovane vrátiť. Toto je
presne ten typ chyby, ktorý pri kombinovaní viacerých zľavových mechanizmov
bez systematického riešenia ľahko vznikne — a je to aj dôvod, prečo takýto
systém dáva zmysel nad rámec jedného e-shopu.

## Úprimne o súčasnom stave

Toto **nie je** hotový produkt, ktorý sa dá "zapnúť" pre nový e-shop za
hodinu. Dnes je to funkčné riešenie postavené na mieru pre jedného klienta
(okfish.sk) — technológia a architektúra sú znovupoužiteľné, ale nasadenie
pre ďalšieho klienta je reálny implementačný projekt, nie inštalácia
doplnku. Pre nového klienta by bolo potrebné:

- Nanovo nastaviť vernostné úrovne, percentá zliav a business pravidlá pre
  kupóny presne podľa jeho obchodného modelu.
- Napojiť sa na jeho konkrétny zdroj produktových dát (feed) a overiť, že
  má rovnaký alebo kompatibilný formát.
- Prepojiť systém s tým, ako jeho e-shop identifikuje prihláseného
  zákazníka a jeho vernostnú úroveň — na okfish.sk to funguje špecifickým
  spôsobom, ktorý sa musí pre iný e-shop overiť alebo prispôsobiť.
- Prispôsobiť zobrazovacie prvky na webe (košík, katalóg, detail produktu)
  dizajnu a šablóne daného e-shopu — tieto sa dnes nahrávajú ručne a nie sú
  automaticky testované, čo znamená, že po každej zmene je potrebná ručná
  kontrola priamo na živom webe.
- Overiť niekoľko známych "sivých zón" v logike (napríklad súbeh
  výpredajovej zľavy s individuálnym stropom na konkrétnom produkte), ktoré
  na okfish.sk zatiaľ neboli prakticky otestované do každého detailu.

Krátko povedané: jadro riešenia — logika poradia zliav, bezpečnostné
poistky, automatická synchronizácia — je overené, funguje v ostrej
prevádzke a dá sa preniesť. Ale každé nové nasadenie si vyžaduje reálnu
prácu na mieru danému e-shopu, nie len prepnutie konfigurácie. Toto je
dôležité komunikovať dopredu, aby očakávania pri ponuke tejto služby
ďalšiemu klientovi zodpovedali realite.

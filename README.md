# Gestione Affitto Condiviso

Web app per la contabilità di uno o più appartamenti in affitto condiviso: inquilini, spese, bonifici, saldi individuali, grafici e promemoria WhatsApp. I dati sono salvati su Firebase (accesso con Google) e si possono esportare/importare in CSV.

Ultimo aggiornamento di questo documento: 19 ottobre 2026 (inquilini archiviati, gestione contratto, messaggio ultimo bonifico, spese ricorrenti).

---

## 1. File del progetto

| File | Contenuto |
|---|---|
| `index.html` | Struttura della pagina (schede, form, tabelle, modale bonifici) |
| `style.css` | Tutti gli stili |
| `script.js` | Tutta la logica: Firebase, calcoli, rendering, import/export, WhatsApp. È un **modulo ES** |
| `firestore.rules` | Regole di sicurezza da pubblicare in Firebase |
| `reset_database_vuoto.csv` | CSV senza dati per azzerare un appartamento |
| `README.md` | Questo documento |

I tre file `index.html`, `style.css` e `script.js` devono stare nella **stessa cartella** e vanno serviti da un server web (Firebase Hosting, GitHub Pages, localhost). Aprendo `index.html` direttamente dal disco il browser blocca `script.js` (moduli ES su `file://`) e il login Google con popup non funziona comunque.

## 2. Messa in funzione (dopo l'aggiornamento)

1. In Firebase Console → Firestore Database → Regole, incolla il contenuto di `firestore.rules` e pubblica. **Senza questo passaggio l'app non legge né scrive** e mostra "🔴 Permessi Firestore insufficienti: aggiorna le regole". Prima di pubblicare prova le regole nel Rules Playground.
2. Carica i tre file sul server e accedi con Google.
3. Al primo accesso l'app migra automaticamente i dati dal vecchio documento unico (vedi sezione 4). Controlla che appartamenti, inquilini, spese e bonifici siano tutti presenti.
4. Quando hai verificato i dati, nelle regole cambia la riga del vecchio documento `users/{userId}` in `allow read, write: if false;`, così non viene più modificato.

## 3. Schede dell'app

**Intestazione (visibile in tutte le schede)**
- Selettore e gestione appartamenti (cambio, rinomina, nuovo, esporta, importa, elimina) e, sotto, il messaggio **"Ultimo bonifico aggiunto il gg/mm/aaaa"**.
- La data è la più recente tra le date dei bonifici dell'appartamento selezionato (compresi quelli di inquilini non più presenti). Se non ce ne sono: "Nessun bonifico registrato". Senza accesso il messaggio non compare. Si aggiorna a ogni salvataggio e al cambio di appartamento.

**Dashboard**
- Quattro riquadri: *Inquilini attivi* (solo contratti in corso), *Numero spese*, *Totale spese*, *Totale da ricevere*.
- Filtro anno ("Da sempre" o un anno specifico): vale per spese, totali e tabelle. Il riquadro *Inquilini attivi* dipende dalla data odierna, non dal filtro.
- Sezione espandibile con 4 grafici (vedi sezione 7).
- "Situazione inquilini": tre riquadri espandibili (*Inquilini attivi*, *In attivazione*, *Archivio*) con totale dovuto, pagato e da pagare per ciascuno.

**Inquilini**
- Form per aggiungere un inquilino (nome, telefono, stanza, affitto mensile, inizio e fine contratto, note).
- Elenco diviso nei tre riquadri espandibili *Inquilini attivi*, *In attivazione*, *Archivio*, con stile distinto (vedi sezione 5).
- Per ogni inquilino: pulsante **Contratto** (rinnovo/estensione o chiusura anticipata). Per gli archiviati il pulsante di eliminazione è **Elimina archiviato** (vedi sezione 5).

**Spese**
- In cima, una riga espandibile (chiusa di default) **"🔁 Aggiungi spesa ricorrente"**: vedi sezione 5-bis.
- Form per registrare una spesa: causale, importo, data, categoria (Luce, Gas, Acqua, Internet, Pulizie, Manutenzione, Condominio, Altro), inquilini coinvolti, note.
- La selezione degli inquilini è facoltativa: senza inquilini la spesa è "generale" e la quota individuale è 0,00 €.
- "Elenco spese" è una scheda espandibile, con filtro per anno, condivisione su WhatsApp ed eliminazione della singola spesa. Contiene anche le occorrenze delle spese ricorrenti (badge "🔁 Ricorrente", inquilini = "Proprietario").
- Pulsante per eliminare in blocco spese e bonifici di un anno (irreversibile).

**Stanze**
- Una scheda espandibile per ogni inquilino, raggruppata in *Attivi / In attivazione / Archivio*.
- Dentro la scheda: riepilogo (spese, affitti maturati, dovuto, pagato, da pagare) e tre sotto-sezioni espandibili (spese personali, mensilità di affitto, bonifici).
- Pulsante per aggiungere un bonifico (modale) e, se c'è un importo dovuto e un numero, per inviare il promemoria WhatsApp.

## 4. Dati e sincronizzazione (Firebase)

Struttura su Firestore, **un documento per appartamento**:

```
users/{uid}                       documento storico (vecchia struttura): letto una sola volta, poi non più modificato
users/{uid}/settings/app          { activePropertyId, migratedAt, migratedFrom }
users/{uid}/properties/{propId}   { name, tenants, expenses, payments, recurring (solo se presente), updatedAt }
```

- **Migrazione**: al primo accesso una transazione copia ogni appartamento del vecchio documento in un documento separato e crea `settings/app`. Il vecchio documento non viene modificato (resta come backup). Se `settings/app` esiste già, la migrazione non si ripete.
- **Salvataggio**: ogni modifica scrive solo l'appartamento attivo. Cambiare appartamento scrive solo `settings/app`. Rinominare scrive solo il nome.
- **Tempo reale**: l'app ascolta la collezione `properties`; ogni modifica (anche da un altro dispositivo) ridisegna le schede.
- **Appartamento attivo**: viene letto una volta al login e poi aggiornato solo da questo dispositivo (non è sincronizzato in tempo reale tra dispositivi).
- **Spazio occupato**: la separazione non riduce lo spazio totale. Riduce i dati scritti a ogni salvataggio e porta il limite di 1 MiB di Firestore da "tutti gli appartamenti insieme" a "ogni appartamento".
- Ogni utente Google ha il proprio spazio `users/{uid}`: cambiando account si vede un database diverso (vuoto, se mai usato).

## 5. Inquilini: stato, contratto e archivio

### Stato (confronto con la data di sistema)

Lo stato si calcola **al giorno**, confrontando le date del contratto con la data del dispositivo che visualizza l'app:

| Stato | Condizione |
|---|---|
| In attivazione | la data di inizio contratto è successiva a oggi |
| Archiviato | la data di fine contratto è precedente a oggi |
| Archiviato (chiusura anticipata) | contratto chiuso in anticipo e data di chiusura uguale o precedente a oggi |
| Attivo | tutti gli altri casi (compresi inquilini senza date) |

Un contratto che finisce oggi è ancora attivo; dal giorno dopo passa in Archivio. Le date salvate nel vecchio formato AAAA-MM vengono lette come primo giorno (inizio) e ultimo giorno (fine) del mese. Lo stato si aggiorna quando la pagina viene ridisegnata (cambio scheda, salvataggio, ricarica): se lasci l'app aperta oltre la mezzanotte, ricarica la pagina.

Gli archiviati mantengono saldo, spese e bonifici e continuano a comparire nei totali, finché non vengono eliminati.

### Ordine e stile

- Ordine ovunque compaiano gli inquilini (Dashboard, Inquilini, Stanze): prima **Attivi** (ordine di inserimento), poi **In attivazione** (per data di inizio), poi **Archivio** (dalla chiusura più recente alla più vecchia).
- Nella pagina Inquilini ogni stato ha un aspetto diverso: righe con barra verde e badge "Attivo · scade il ..." per gli attivi; barra arancione e "Inizia il ..." per quelli in attivazione; righe grigie e badge "Contratto concluso il ..." o "Chiuso in anticipo il ..." per gli archiviati. Il periodo di contratto è mostrato con le date complete.

### Contratto: rinnovo / estensione e chiusura anticipata

Il pulsante **Contratto** (su ogni inquilino) apre una finestra con il contratto attuale e due scelte:

- **Rinnova / estendi**: nuova data di fine (deve essere successiva all'attuale scadenza), con le scorciatoie +3, +6, +12 mesi dalla scadenza attuale. Su un archiviato con data nel futuro, l'inquilino torna attivo.
- **Chiudi in anticipo**: data di chiusura (proposta: oggi; deve cadere tra l'inizio del contratto e l'attuale scadenza). Con la data di oggi l'inquilino passa subito in Archivio. Non disponibile per gli inquilini già archiviati.

Prima di applicare, la finestra mostra il contratto risultante, lo stato risultante e come cambia l'**affitto maturato**: ad esempio, rinnovare un contratto scaduto da sei mesi addebita all'inquilino i sei mesi trascorsi, perché per l'app il contratto è unico e continuo (vedi sezione 6). La chiusura anticipata chiede una conferma.

### Cancellazione di un inquilino archiviato

Il pulsante **Elimina archiviato** (solo sugli archiviati) rimuove dal resoconto complessivo:

- l'inquilino;
- tutti i **bonifici** da lui effettuati;
- le **spese a suo carico**: quelle intestate solo a lui vengono eliminate; per quelle **condivise** con altri inquilini si toglie solo la sua quota (l'importo della spesa si riduce della quota e lui esce dall'elenco degli inquilini coinvolti), così le quote degli altri restano identiche. Nelle note della spesa viene aggiunta la dicitura con la quota rimossa e l'importo originale.

Prima di procedere compare un riepilogo con numero e totale di bonifici e spese, e l'importo che l'inquilino doveva ancora (che non verrà più contato in "Totale da ricevere"). L'operazione è irreversibile: esporta prima un backup CSV. Per gli inquilini attivi o in attivazione resta il pulsante **Elimina**, che toglie solo l'inquilino (vedi sezione 13).

## 5-bis. Spese ricorrenti

Spese fisse **a carico del proprietario**: non hanno inquilini, quindi non entrano nei saldi degli inquilini né nelle schede Stanze.

**Inserimento** (Spese → riga "Aggiungi spesa ricorrente"):
- Nome della spesa, importo **mensile**, categoria (stesso elenco delle spese classiche, copiato dal modulo "Aggiungi spesa") e data di inizio (proposta: oggi).
- Durata: **a tempo indeterminato** oppure **un periodo di N mesi** (da 1 a 600).
- La spesa si ripete ogni mese nello stesso giorno della data di inizio (se il mese è più corto, l'ultimo giorno: il 31 gennaio diventa il 28/29 febbraio).

**Conteggio**:
- Le occorrenze non sono salvate una per una: si calcolano fino alla **data di sistema**. Le occorrenze future compaiono (in elenco, riquadri e grafici) man mano che la loro data arriva. Una serie da 12 mesi iniziata oggi mostra quindi una sola occorrenza, poi una al mese.
- Compaiono nell'**Elenco spese** (con il filtro anno), nei riquadri della Dashboard ("Spese registrate", "Totale spese") e nei grafici in base alla categoria: Luce, Gas, Acqua nel grafico 3; Condominio, Manutenzione, Internet nel grafico 4; tutte le categorie nel totale spese del grafico 2.

**Interruzione "da un certo punto in poi"**:
- Pulsante **Interrompi da…** nell'elenco "Spese ricorrenti inserite", oppure **Interrompi da qui** su una singola occorrenza dell'elenco spese.
- Si sceglie il giorno di interruzione (deve essere successivo alla data di inizio): da quel giorno in poi, compreso, non si genera più nulla. L'anteprima mostra quante occorrenze già registrate vengono rimosse (con conferma). Se la data è futura, le occorrenze già registrate non cambiano.
- **Elimina** cancella l'intera serie con tutte le sue occorrenze.
- **Elimina per anno** (scheda Spese) toglie anche le occorrenze ricorrenti di quell'anno; la serie resta valida negli altri anni.

**Dati**: nel documento dell'appartamento il campo `recurring` (lista di serie `{ id, name, category, amount, startDate, months, stopFrom, excludeYears }`) compare solo quando esiste almeno una spesa ricorrente. Le regole Firestore vanno aggiornate (sezione 11).

## 6. Calcolo dei saldi

- **Affitti maturati**: un mese per ogni mese compreso tra inizio e fine contratto, **fino al mese corrente** (i mesi futuri non maturano ancora) × affitto mensile. Il mese della data di fine (o di chiusura anticipata) conta per intero.
- **Quota spesa**: importo ÷ numero di inquilini selezionati nella spesa.
- **Totale dovuto** = affitti maturati + quote spese.
- **Da pagare** = totale dovuto − bonifici (mostrato solo se positivo).
- Con un anno selezionato si considerano solo i mesi di quell'anno, le spese e i bonifici con data in quell'anno.

## 7. Grafici (Chart.js)

Tutti i grafici seguono il filtro anno della Dashboard:
- **anno selezionato**: asse orizzontale con i 12 mesi dell'anno (Gen ... Dic);
- **"Da sempre"**: linea temporale reale con mese e anno (Gen 2025, Feb 2025, ...). Gli anni **non vengono sommati** nello stesso mese. Intervallo massimo: 600 mesi (protezione contro date errate).

I grafici:
1. **Inquilini con contratto attivo, mese per mese** (a barre). Con "Da sempre" l'intervallo va dal primo inizio contratto all'ultima fine. Contano solo gli inquilini con entrambe le date.
2. **Entrate (bonifici) vs spese** (a barre). Con "Da sempre" l'intervallo va dal primo all'ultimo mese con almeno una spesa o un bonifico; i mesi intermedi senza movimenti valgono 0. Le spese sono contate per l'importo totale, non per la quota dei singoli inquilini.
3. **Utenze primarie**: Luce, Gas, Acqua (linee).
4. **Altre spese**: Condominio, Manutenzione, Internet (linee).

Nei grafici 3 e 4 i mesi senza spese di quella categoria sono `null` e `spanGaps: true` collega solo i punti reali. Le categorie Pulizie e Altro compaiono solo nel totale spese del grafico 2. Con "Da sempre" i grafici 2, 3 e 4 condividono lo stesso intervallo di mesi, che può essere diverso da quello del grafico 1 (basato sui contratti).

I grafici si ridisegnano quando la sezione è aperta e cambia il filtro anno.

## 8. Schede espandibili

Lo stato aperto/chiuso delle schede generate dinamicamente (riquadri degli inquilini, sotto-sezioni, gruppi Attivi/In attivazione/Archivio) viene ricordato: dopo un salvataggio o un aggiornamento dei dati restano come le avevi lasciate. Gli identificativi delle schede dipendono dall'id dell'inquilino, non dalla posizione. Il riquadro "Inquilini attivi" è aperto di default, gli altri due chiusi.

## 9. Export / Import CSV

- File con separatore `;`, codifica UTF-8 con BOM, quattro sezioni: `=== INQUILINI ===`, `=== SPESE APPARTAMENTO ===`, `=== BONIFICI INQUILINI ===`, `=== SPESE RICORRENTI ===`, ciascuna con la riga di intestazione. La sezione delle spese ricorrenti ha le colonne ID, Nome, Categoria, Importo Mensile, Data Inizio, Mesi (vuoto = tempo indeterminato), Interrotta Da, Anni Esclusi.
- La sezione inquilini ha la colonna finale **Chiuso in anticipo** (`1` se il contratto è stato chiuso in anticipo). I file esportati in precedenza, senza questa colonna, si importano normalmente.
- Tutti i campi sono tra virgolette, con `"` raddoppiate: nomi e note con virgolette, `;` o a capo si esportano e reimportano correttamente.
- L'esportazione riguarda l'**appartamento attivo**. Nei bonifici di un inquilino non più presente il nome è "Sconosciuto" (il nome serve solo alla lettura: all'import contano ID inquilino, data, causale, importo, note).
- Un file senza la sezione delle spese ricorrenti (esportato prima di questo aggiornamento) si importa normalmente, ma azzera le spese ricorrenti dell'appartamento: l'importazione sostituisce sempre tutti i dati.
- L'importazione **sostituisce** inquilini, spese, bonifici e spese ricorrenti dell'appartamento attivo, dopo una conferma che mostra quanti record sono stati trovati. Importi con virgola (`350,50`) o con punto (`350.5`) sono accettati. Un file senza struttura valida viene rifiutato.
- **Reset di un appartamento**: seleziona l'appartamento, esporta un backup, poi importa `reset_database_vuoto.csv`. Il file ha solo le intestazioni: l'app chiede una conferma esplicita e azzera inquilini, spese, bonifici e spese ricorrenti. Per svuotare un altro appartamento ripeti l'operazione dopo averlo selezionato.

## 10. WhatsApp

- **Nuova spesa**: messaggio precompilato con causale, importo, data, categoria, inquilini e quota a persona.
- **Promemoria di pagamento**: messaggio con totale dovuto, pagato e da pagare, inviato al numero dell'inquilino (il numero viene ripulito: solo cifre, senza zeri iniziali).

## 11. Regole di sicurezza Firestore (`firestore.rules`)

- Ogni utente può leggere e scrivere solo sotto `users/{il proprio uid}`.
- Un documento appartamento accetta solo i campi `name`, `tenants`, `expenses`, `payments`, `recurring` (facoltativo, lista di al massimo 200 voci), `updatedAt`, con tipi controllati, nome da 1 a 100 caratteri e al massimo 200 inquilini.
- **Dopo l'introduzione delle spese ricorrenti ripubblica `firestore.rules`**: con le regole precedenti il salvataggio di un appartamento che contiene spese ricorrenti viene rifiutato ("Permessi Firestore insufficienti").
- `settings/app` accetta solo `activePropertyId`, `migratedAt`, `migratedFrom`.
- Il vecchio documento `users/{uid}` resta modificabile finché non cambi la regola (vedi sezione 2).
- Tutto il resto è vietato.
- Consigliato inoltre: limitare la chiave API ai propri domini (Google Cloud Console → Credenziali) e verificare i domini autorizzati in Firebase Authentication.

---

## 12. Registro delle modifiche

**Prima revisione (correzioni)**
- Nuovo appartamento: non eredita più i dati di quello precedente.
- Eliminazione appartamento: non sovrascrive più l'appartamento rimasto con i dati di quello eliminato.
- Importazione CSV riscritta (virgolette, `;` e a capo nei testi, virgola decimale, date dei bonifici, ID sicuri) e resa compatibile con file vuoti per il reset.
- WhatsApp: link `wa.me` con numero ripulito.

**Seconda revisione**
- Inquilini divisi in Attivi / In attivazione / Archivio (Dashboard, Inquilini, Stanze); il riquadro "Inquilini attivi" conta solo i contratti in corso.
- Grafico 1 con "Da sempre": conteggio reale mese per mese.
- Schede espandibili che restano aperte dopo un salvataggio.
- Un documento Firebase per appartamento, con migrazione non distruttiva e regole di sicurezza.
- Codice suddiviso in `index.html`, `style.css`, `script.js`.
- Bonifici degli inquilini non più attivi conservati ("Sconosciuto" nell'export).

**Terza revisione**
- Grafici 2, 3 e 4 con "Da sempre": ora usano una linea temporale reale (mese e anno) invece di sommare lo stesso mese di anni diversi.

**Quarta revisione**
- Stato degli inquilini calcolato al giorno rispetto alla data di sistema (prima: al mese).
- Pagina Inquilini: stile distinto per attivi, in attivazione e archiviati; archiviati ordinati per data di chiusura.
- Funzione Contratto per ogni inquilino: rinnovo/estensione e chiusura anticipata, con anteprima dell'effetto sull'affitto maturato.
- Funzione Elimina archiviato: rimuove inquilino, bonifici e spese a suo carico dal resoconto complessivo.
- CSV: nuova colonna "Chiuso in anticipo"; `reset_database_vuoto.csv` aggiornato.

**Quinta revisione**
- Intestazione: messaggio con la data dell'ultimo bonifico (gg/mm/aaaa), visibile in tutte le schede sotto la gestione dell'appartamento.

**Sesta revisione**
- Spese ricorrenti a carico del proprietario: inserimento (a tempo indeterminato o per N mesi), interruzione da una data in poi, eliminazione, presenza nell'elenco spese, nei riquadri e nei grafici per categoria.
- CSV: nuova sezione `=== SPESE RICORRENTI ===`; `reset_database_vuoto.csv` e `firestore.rules` aggiornati.

---

## 13. Errori e limiti noti NON ancora corretti

**Errori nel codice**
1. **Promemoria WhatsApp**: il messaggio usa i totali "da sempre", mentre la scheda mostra i totali dell'anno selezionato. Con un filtro anno attivo gli importi nel messaggio possono differire da quelli a schermo.
2. **Form delle spese, selezione inquilini**: l'elenco comprende anche inquilini archiviati o in attivazione, e le spunte si azzerano a ogni ridisegno (cambio scheda, salvataggio, aggiornamento da un altro dispositivo) se non hai ancora premuto Salva.
3. **Nome appartamento**: un nome che contiene `prop_` viene sostituito con "Appartamento N".
4. **Eliminazione per anno**: l'avviso "eliminati con successo" compare senza attendere la conferma del salvataggio.

**Limiti e punti da conoscere**
5. **Nessuna persistenza offline**: senza connessione lo stato resta "⏳ Salvataggio..." e le modifiche non ancora sincronizzate si perdono se chiudi la pagina.
6. **Senza accesso** i form non salvano nulla: compare l'avviso e si apre il login.
7. **Selezione account Google non forzata**: il login può riproporre subito l'ultimo account. Soluzione (non applicata): `provider.setCustomParameters({ prompt: "select_account" });` dopo la creazione di `provider`.
8. **CSV e Excel**: l'export scrive i decimali con il punto (`120.5`). L'app li reimporta correttamente, ma Excel con impostazioni italiane può non riconoscerli come numeri se apri e risalvi il file.
9. **Eliminazione con «Elimina»** (inquilini attivi o in attivazione): toglie solo l'inquilino. I suoi bonifici restano (nell'export compaiono come "Sconosciuto") e nelle spese a lui collegate il suo id resta tra i coinvolti, quindi la quota degli altri non cambia e nel messaggio WhatsApp compare "Inquilino". Per ripulire tutto, archivia l'inquilino (chiusura anticipata) e usa «Elimina archiviato».
10. **Saldo per anno**: un bonifico conta nell'anno della sua data, anche se salda debiti di anni precedenti.
11. **Eliminazione per anno e importazione** sono irreversibili: esporta sempre un backup prima.
12. **Grafici con "Da sempre"**: l'intervallo è limitato a 600 mesi (protezione contro date errate). Con molti anni di dati l'asse orizzontale diventa fitto e Chart.js salta alcune etichette.
13. **Limite di 1 MiB per appartamento**: invariato (un appartamento con molte migliaia di spese e bonifici potrebbe raggiungerlo).
14. **Documento storico** `users/{uid}`: scrivibile finché non cambi la regola.
16. **Rinnovo di un contratto scaduto**: l'app ha un solo contratto continuo per inquilino, quindi i mesi tra la vecchia scadenza e oggi vengono addebitati (l'anteprima li mostra). Non è possibile rappresentare un periodo di assenza tra due contratti.
17. **Elimina archiviato sulle spese condivise**: l'importo originale della spesa viene ridotto (resta scritto nelle note). Il totale spese dell'appartamento diminuisce della quota stralciata; l'operazione non si può annullare.
18. **Stanze e Dashboard**: il pulsante Contratto e la cancellazione degli archiviati sono solo nella pagina Inquilini.
19. **Data di sistema**: lo stato usa la data del dispositivo (fuso locale). Con data o orologio errati gli inquilini cambiano stato di conseguenza.

**Ultimo bonifico**
20. Il messaggio nell'intestazione mostra la data più recente tra i bonifici, non il momento in cui l'ultimo è stato inserito: un bonifico inserito oggi ma datato in passato non cambia il messaggio. I bonifici con data non valida vengono ignorati.

**Spese ricorrenti**
21. Cadenza solo **mensile**; l'importo è fisso per tutta la durata (per cambiare importo: interrompi la serie e creane una nuova).
22. Le occorrenze future non sono conteggiate fino alla loro data: i grafici e i totali non mostrano previsioni.
23. L'eliminazione per anno rimuove solo le occorrenze di quell'anno (annotando l'anno nella serie): non c'è un modo per togliere un solo mese in mezzo a una serie.
24. Le spese ricorrenti non si condividono su WhatsApp e non hanno note.

**Non verificato**
25. Le modifiche sono state provate con un Firestore e un DOM simulati (migrazione, salvataggi, sezioni, grafici, schede aperte, export/import, reset, stati degli inquilini, contratto, cancellazione degli archiviati, messaggio dell'ultimo bonifico, spese ricorrenti). Non sono state provate su Firebase reale, in un browser, né le regole con l'emulatore Firestore. Prima di usarle con i dati veri, esporta un backup CSV di ogni appartamento.

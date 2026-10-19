# Gestione Affitto Condiviso

Web app per la contabilità di uno o più appartamenti in affitto condiviso: inquilini, spese, bonifici, saldi individuali, grafici e promemoria WhatsApp. I dati sono salvati su Firebase (accesso con Google) e si possono esportare/importare in CSV.

Ultimo aggiornamento di questo documento: 19 ottobre 2026.

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

**Dashboard**
- Quattro riquadri: *Inquilini attivi* (solo contratti in corso), *Numero spese*, *Totale spese*, *Totale da ricevere*.
- Filtro anno ("Da sempre" o un anno specifico): vale per spese, totali e tabelle. Il riquadro *Inquilini attivi* dipende dalla data odierna, non dal filtro.
- Sezione espandibile con 4 grafici (vedi sezione 7).
- "Situazione inquilini": tre riquadri espandibili (*Inquilini attivi*, *In attivazione*, *Archivio*) con totale dovuto, pagato e da pagare per ciascuno.

**Inquilini**
- Form per aggiungere un inquilino (nome, telefono, stanza, affitto mensile, inizio e fine contratto, note).
- Elenco diviso negli stessi tre riquadri espandibili.

**Spese**
- Form per registrare una spesa: causale, importo, data, categoria (Luce, Gas, Acqua, Internet, Pulizie, Manutenzione, Condominio, Altro), inquilini coinvolti, note.
- La selezione degli inquilini è facoltativa: senza inquilini la spesa è "generale" e la quota individuale è 0,00 €.
- "Elenco spese" è una scheda espandibile, con filtro per anno, condivisione su WhatsApp ed eliminazione della singola spesa.
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
users/{uid}/properties/{propId}   { name, tenants, expenses, payments, updatedAt }
```

- **Migrazione**: al primo accesso una transazione copia ogni appartamento del vecchio documento in un documento separato e crea `settings/app`. Il vecchio documento non viene modificato (resta come backup). Se `settings/app` esiste già, la migrazione non si ripete.
- **Salvataggio**: ogni modifica scrive solo l'appartamento attivo. Cambiare appartamento scrive solo `settings/app`. Rinominare scrive solo il nome.
- **Tempo reale**: l'app ascolta la collezione `properties`; ogni modifica (anche da un altro dispositivo) ridisegna le schede.
- **Appartamento attivo**: viene letto una volta al login e poi aggiornato solo da questo dispositivo (non è sincronizzato in tempo reale tra dispositivi).
- **Spazio occupato**: la separazione non riduce lo spazio totale. Riduce i dati scritti a ogni salvataggio e porta il limite di 1 MiB di Firestore da "tutti gli appartamenti insieme" a "ogni appartamento".
- Ogni utente Google ha il proprio spazio `users/{uid}`: cambiando account si vede un database diverso (vuoto, se mai usato).

## 5. Stato degli inquilini

Calcolato per **mese**, come gli affitti maturati:

| Stato | Condizione |
|---|---|
| In attivazione | il mese di inizio contratto è successivo al mese corrente |
| Archivio | il mese di fine contratto è precedente al mese corrente |
| Attivo | tutti gli altri casi (compresi inquilini senza date) |

Un contratto che finisce a metà marzo resta "attivo" fino a fine marzo. Gli inquilini in Archivio mantengono saldo, spese e bonifici e continuano a comparire nei totali.

## 6. Calcolo dei saldi

- **Affitti maturati**: un mese per ogni mese compreso tra inizio e fine contratto, **fino al mese corrente** (i mesi futuri non maturano ancora) × affitto mensile.
- **Quota spesa**: importo ÷ numero di inquilini selezionati nella spesa.
- **Totale dovuto** = affitti maturati + quote spese.
- **Da pagare** = totale dovuto − bonifici (mostrato solo se positivo).
- Con un anno selezionato si considerano solo i mesi di quell'anno, le spese e i bonifici con data in quell'anno.

## 7. Grafici (Chart.js)

1. **Inquilini con contratto attivo, mese per mese** (a barre). Con un anno selezionato: i 12 mesi dell'anno. Con "Da sempre": dal primo inizio contratto all'ultima fine, con il numero reale di contratti attivi in ciascun mese (massimo 600 mesi). Contano solo gli inquilini con entrambe le date.
2. **Entrate (bonifici) vs spese** (a barre).
3. **Utenze primarie**: Luce, Gas, Acqua (linee). I mesi senza bollette sono `null` e `spanGaps: true` collega solo i punti reali.
4. **Altre spese**: Condominio, Manutenzione, Internet (linee, stessa logica).

I grafici si ridisegnano quando la sezione è aperta e cambia il filtro anno.

## 8. Schede espandibili

Lo stato aperto/chiuso delle schede generate dinamicamente (riquadri degli inquilini, sotto-sezioni, gruppi Attivi/In attivazione/Archivio) viene ricordato: dopo un salvataggio o un aggiornamento dei dati restano come le avevi lasciate. Gli identificativi delle schede dipendono dall'id dell'inquilino, non dalla posizione. Il riquadro "Inquilini attivi" è aperto di default, gli altri due chiusi.

## 9. Export / Import CSV

- File con separatore `;`, codifica UTF-8 con BOM, tre sezioni: `=== INQUILINI ===`, `=== SPESE APPARTAMENTO ===`, `=== BONIFICI INQUILINI ===`, ciascuna con la riga di intestazione.
- Tutti i campi sono tra virgolette, con `"` raddoppiate: nomi e note con virgolette, `;` o a capo si esportano e reimportano correttamente.
- L'esportazione riguarda l'**appartamento attivo**. Nei bonifici di un inquilino non più presente il nome è "Sconosciuto" (il nome serve solo alla lettura: all'import contano ID inquilino, data, causale, importo, note).
- L'importazione **sostituisce** inquilini, spese e bonifici dell'appartamento attivo, dopo una conferma che mostra quanti record sono stati trovati. Importi con virgola (`350,50`) o con punto (`350.5`) sono accettati. Un file senza struttura valida viene rifiutato.
- **Reset di un appartamento**: seleziona l'appartamento, esporta un backup, poi importa `reset_database_vuoto.csv`. Il file ha solo le intestazioni: l'app chiede una conferma esplicita e azzera inquilini, spese e bonifici. Per svuotare un altro appartamento ripeti l'operazione dopo averlo selezionato.

## 10. WhatsApp

- **Nuova spesa**: messaggio precompilato con causale, importo, data, categoria, inquilini e quota a persona.
- **Promemoria di pagamento**: messaggio con totale dovuto, pagato e da pagare, inviato al numero dell'inquilino (il numero viene ripulito: solo cifre, senza zeri iniziali).

## 11. Regole di sicurezza Firestore (`firestore.rules`)

- Ogni utente può leggere e scrivere solo sotto `users/{il proprio uid}`.
- Un documento appartamento accetta solo i campi `name`, `tenants`, `expenses`, `payments`, `updatedAt`, con tipi controllati, nome da 1 a 100 caratteri e al massimo 200 inquilini.
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

---

## 13. Errori e limiti noti NON ancora corretti

**Errori nel codice**
1. **Grafici 2, 3 e 4 con "Da sempre"**: sommano lo stesso mese di anni diversi (tutti i gennaio insieme, ecc.). Solo il grafico 1 è stato portato su una linea temporale reale.
2. **Promemoria WhatsApp**: il messaggio usa i totali "da sempre", mentre la scheda mostra i totali dell'anno selezionato. Con un filtro anno attivo gli importi nel messaggio possono differire da quelli a schermo.
3. **Form delle spese, selezione inquilini**: l'elenco comprende anche inquilini archiviati o in attivazione, e le spunte si azzerano a ogni ridisegno (cambio scheda, salvataggio, aggiornamento da un altro dispositivo) se non hai ancora premuto Salva.
4. **Nome appartamento**: un nome che contiene `prop_` viene sostituito con "Appartamento N".
5. **Eliminazione per anno**: l'avviso "eliminati con successo" compare senza attendere la conferma del salvataggio.

**Limiti e punti da conoscere**
6. **Nessuna persistenza offline**: senza connessione lo stato resta "⏳ Salvataggio..." e le modifiche non ancora sincronizzate si perdono se chiudi la pagina.
7. **Senza accesso** i form non salvano nulla: compare l'avviso e si apre il login.
8. **Selezione account Google non forzata**: il login può riproporre subito l'ultimo account. Soluzione (non applicata): `provider.setCustomParameters({ prompt: "select_account" });` dopo la creazione di `provider`.
9. **CSV e Excel**: l'export scrive i decimali con il punto (`120.5`). L'app li reimporta correttamente, ma Excel con impostazioni italiane può non riconoscerli come numeri se apri e risalvi il file.
10. **Inquilino eliminato**: i suoi bonifici restano (voluto). Nelle spese a lui collegate il suo id resta tra i coinvolti, quindi la quota degli altri non cambia e nel messaggio WhatsApp compare "Inquilino".
11. **Saldo per anno**: un bonifico conta nell'anno della sua data, anche se salda debiti di anni precedenti.
12. **Eliminazione per anno e importazione** sono irreversibili: esporta sempre un backup prima.
13. **Grafico 1**: l'intervallo "Da sempre" è limitato a 600 mesi (protezione contro date errate).
14. **Limite di 1 MiB per appartamento**: invariato (un appartamento con molte migliaia di spese e bonifici potrebbe raggiungerlo).
15. **Documento storico** `users/{uid}`: scrivibile finché non cambi la regola.

**Non verificato**
16. Le modifiche sono state provate con un Firestore e un DOM simulati (migrazione, salvataggi, sezioni, grafico 1, schede aperte, export/import, reset). Non sono state provate su Firebase reale, in un browser, né le regole con l'emulatore Firestore. Prima di usarle con i dati veri, esporta un backup CSV di ogni appartamento.

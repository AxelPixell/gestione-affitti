================================================================================
                    GUIDA ED EVOLUZIONE DELL'APPLICAZIONE
                    "GESTIONE AFFITTO CONDIVISO"
================================================================================

1. PANORAMICA E FUNZIONAMENTO DELL'APPLICAZIONE
--------------------------------------------------------------------------------
L'applicazione è una Web App completa per la gestione della contabilità di uno o 
più appartamenti in affitto condiviso. Permette di monitorare entrate, spese, 
saldi individuali e storici tramite un'interfaccia semplice e reattiva.

Caratteristiche principali e struttura:
- Gestione Multi-Appartamento: Permette di creare, rinominare ed eliminare più 
  immobili, mantenendo i dati completamente separati.
- Sincronizzazione Cloud (Firebase): Accedendo con Google, tutti i dati vengono 
  salvati e sincronizzati in tempo reale sul cloud.
- Export / Import CSV: Possibilità di scaricare tutti i dati in formato foglio 
  di calcolo (CSV) o di ripristinarli da un file di backup.
- Calcolo automatico dei saldi: Il sistema calcola mese per mese l'affitto 
  dovuto e le quote delle spese, sottraendo i bonifici già effettuati dall'inquilino.
- Integrazione WhatsApp: Invia direttamente messaggi precompilati su WhatsApp 
  per notificare nuove spese o inviare promemoria di pagamento.


2. ARCHITETTURA DELLE SEZIONI (SCHEDE)
--------------------------------------------------------------------------------
- DASHBOARD:
  * Riquadri con le statistiche generali (inquilini attivi, numero spese, 
    totale spese e totale ancora da ricevere).
  * Menu a tendina per filtrare l'intera situazione per un anno specifico o "Da sempre".
  * Sezione espandibile con 4 grafici interattivi (Chart.js) per analizzare 
    l'andamento di inquilini, entrate vs spese e utenze.
  * Tabella di riepilogo rapido della situazione di ogni inquilino.

- INQUILINI:
  * Form per l'inserimento di un nuovo inquilino (Nome, Telefono, Stanza, 
    Affitto mensile, Date di inizio e fine contratto, Note).
  * Tabella con l'elenco degli inquilini registrati nell'appartamento attivo.

- SPESE:
  * Form per registrare una nuova spesa (Causale, Importo, Data, Categoria, 
    Selezione opzionale degli inquilini coinvolti, Note).
  * Filtro per anno per consultare lo storico.
  * Pulsante per l'eliminazione in blocco dei dati (spese e bonifici) di un anno.
  * Tabella spese con opzioni per condividere la spesa su WhatsApp o eliminarla.

- STANZE:
  * Schede dettagliate per ciascun inquilino contenenti il resoconto completo:
    - Spese personali addebitate.
    - Mensilità di affitto maturate nell'arco del contratto.
    - Bonifici registrati con possibilità di aggiungerne di nuovi tramite modale.
    - Stato del saldo (In credito / Da pagare) con pulsante per invio promemoria WhatsApp.


3. EVOLUZIONE DEL CODICE E MODIFICHE APPORTATE PASSO PASSO
--------------------------------------------------------------------------------

[PASSO 1] Integrazione Filtro Anno in Dashboard
- Aggiunta di un menu a tendina (`<select id="yearFilterDashboard">`) nella Dashboard.
- Aggiornamento della funzione `updateYearDropdowns()` per includere il nuovo selettore.
- Modifica di `renderDashboard()` per ri-calcolare in tempo reale le statistiche 
  e le tabelle in base all'anno selezionato ("Da sempre" o anno specifico).

[PASSO 2] Aggiornamento Categorie Spesa
- Sostituzione della categoria generica "Utenze" con le voci specifiche:
  * Luce
  * Gas
  * Acqua
- Aggiunta della categoria "Manutenzione".
- La lista completa delle categorie nel form è diventata: Luce, Gas, Acqua, 
  Internet, Pulizie, Manutenzione, Condominio, Altro.

[PASSO 3] Rimozione del vincolo sulla selezione degli Inquilini per le Spese
- Rimozione del controllo di blocco JavaScript che richiedeva obbligatoriamente 
  la selezione di almeno un inquilino al momento del salvataggio.
- Consentita la registrazione di spese "Generali" relative all'appartamento, 
  con lista inquilini vuota (`[]`) e quota individuale pari a € 0,00.

[PASSO 4] Integrazione Grafici Interattivi e Sezione Espandibile in Dashboard
- Inserimento della libreria Chart.js tramite CDN nell'header dell'applicazione.
- Creazione di una sezione a tendina (collapsible/accordion) per mostrare o 
  nascondere i grafici a scelta dell'utente.
- Realizzazione di 4 grafici dinamici collegati al filtro anno della Dashboard:
  1. Inquilini attivi mese per mese (Grafico a barre).
  2. Entrate (Bonifici) vs Spese (Grafico a barre comparativo).
  3. Utenze primarie: Luce, Gas, Acqua (Grafico a linee con colori dedicati).
  4. Altre spese: Condominio, Manutenzione, Internet (Grafico a linee).

================================================================================

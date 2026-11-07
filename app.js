/* ==== js/db.js ==== */
/*!
 * db.js - Couche de données partagée (localStorage) pour LivraisonManager.
 * Aucune dépendance externe. Toutes les pages incluent ce fichier avant leur script propre.
 */
(function (global) {
  "use strict";

  var STORAGE_KEY = "lm_data_v1";

  // -----------------------------------------------------------------------
  // Utilitaires
  // -----------------------------------------------------------------------

  function uid(prefix) {
    return (prefix || "id") + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function normalizeStr(s) {
    if (!s) return "";
    return s.toString().trim().toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // retire les accents
      .replace(/\s+/g, " ");
  }

  // Date du jour au format "YYYY-MM-DD", en heure LOCALE (pas UTC). new Date().toISOString()
  // convertit en UTC, ce qui décale la date d'un jour pendant plusieurs heures chaque jour dans
  // tout fuseau horaire en avance sur UTC (ex : la France, en UTC+1 ou +2) : entre minuit et 1h
  // ou 2h du matin, "aujourd'hui" était donc en réalité encore la veille en UTC.
  function todayISO() {
    var d = new Date();
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + "-" + (m < 10 ? "0" : "") + m + "-" + (day < 10 ? "0" : "") + day;
  }

  function fmtEUR(n) {
    n = Number(n) || 0;
    return n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
  }

  function fmtNum(n) {
    return Number(n || 0).toLocaleString("fr-FR");
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    var d = new Date(iso + (iso.length === 10 ? "T00:00:00" : ""));
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
  }

  // Formate un numéro de ticket de réparation en référence lisible (ex. 7 -> "TCK-0007").
  function fmtTicketRef(n) {
    if (n === undefined || n === null || n === "") return "—";
    var s = String(Math.trunc(Number(n)));
    while (s.length < 4) s = "0" + s;
    return "TCK-" + s;
  }

  // -----------------------------------------------------------------------
  // Chargement / sauvegarde
  // -----------------------------------------------------------------------

  var DEFAULT_DATA = {
    version: 1,
    entrepots: [],
    livreurs: [],
    vehicules: [],
    materiels: [],
    livraisons: [],
    importBatches: [],
    // Annuaire des clients (livrés) et suivi des retards signalés sur les entrées du journal des
    // livraisons (import Excel ou saisie manuelle, page Analyse). Un retard est rattaché à une
    // entrée précise du journal (livraisonId) et porte le nombre de livraisons en retard sur
    // cette entrée ainsi que la liste des clients concernés (clients: [{clientId, tempsRetard,
    // justifications}], chaque client rattaché à l'annuaire avec son propre temps de retard et
    // jusqu'à 3 justificatifs choisis dans la liste de référence motifsRetard, page Annexes).
    clients: [],
    retards: [],
    primesTiers: [],
    primesAjustements: [],
    ticketsReparation: [],
    // Journal d'activité (page Historique) : trace des ajouts/modifications/suppressions
    // effectués sur les entités de l'application (livreurs, clients, véhicules...), alimenté via
    // DB.logHistorique(page, action, description). Purement informatif — sa suppression (ligne
    // par ligne, depuis la page Historique) n'affecte jamais les données réelles.
    historique: [],
    settings: { entrepriseName: "Ma société de livraison", nextTicketNumber: 1 },
    // Listes de référence personnalisables depuis la page Annexes (catégories de matériel, types
    // de véhicules, parties contrôlées lors d'un contrôle véhicule...). Chaque entrée conserve une
    // clé stable (utilisée dans les enregistrements) et un libellé modifiable à tout moment sans
    // casser les données déjà saisies.
    listesRef: {
      categoriesMateriel: [
        { key: "bacs", label: "Bacs" },
        { key: "chariots", label: "Chariots / diables" },
        { key: "scanners", label: "Scanners" },
        { key: "autre", label: "Autre" }
      ],
      typesVehicule: [
        { key: "camion", label: "Camion" },
        { key: "camionnette", label: "Camionnette" },
        { key: "utilitaire", label: "Utilitaire" },
        { key: "scooter", label: "Scooter" },
        { key: "velo", label: "Vélo" },
        { key: "velo_cargo", label: "Vélo cargo" }
      ],
      partiesControle: [
        { key: "direction", label: "Direction / guidon" },
        { key: "freins", label: "Freins" },
        { key: "roues", label: "Roues et pneus" },
        { key: "transmission", label: "Transmission / chaîne" },
        { key: "eclairage", label: "Éclairage" },
        { key: "structure", label: "Structure / cadre" },
        { key: "moteur", label: "Moteur" },
        { key: "niveaux", label: "Niveaux et fluides" },
        { key: "batterie", label: "Batterie" },
        { key: "securite", label: "Accessoires de sécurité (klaxon, rétroviseurs...)" }
      ],
      // Justificatifs proposés lors de la saisie d'un retard (page Retards), pour chaque client
      // concerné (jusqu'à 3 par client).
      motifsRetard: [
        { key: "trafic", label: "Trafic / circulation" },
        { key: "client_absent", label: "Client absent" },
        { key: "probleme_vehicule", label: "Problème véhicule" },
        { key: "erreur_adresse", label: "Erreur d'adresse" },
        { key: "retard_entrepot", label: "Retard au départ de l'entrepôt" },
        { key: "meteo", label: "Météo" },
        { key: "autre", label: "Autre" }
      ],
      // Types d'absence proposés dans Planning (case du planning et "Nouvelle demande"). Chaque
      // type porte une couleur (hex) personnalisable depuis Annexes, reprise sur la grille du
      // planning et sur le récapitulatif "Effectif du jour". Les types "Travail" et "Repos" ne
      // font pas partie de cette liste : ce sont des jours travaillés/de repos, pas des absences.
      typesAbsence: [
        { key: "cp", label: "Congé payé (CP)", color: "#2f7bd6" },
        { key: "rtt", label: "RTT", color: "#14b8a6" },
        { key: "absence", label: "Absence injustifiée", color: "#d64545" },
        { key: "maladie", label: "Arrêt maladie", color: "#d68a13" },
        { key: "ferie", label: "Jour férié", color: "#3454d1" }
      ]
    },
    // Planning hebdomadaire des livreurs : une entrée par livreur et par jour (travail / repos /
    // congé / absence...), des demandes d'absence (historique) qui alimentent la génération
    // automatique, et des réglages par défaut (horaires, pause, dimanche travaillé ou non).
    planningEntrees: [],
    demandesAbsence: [],
    planningReglages: {
      heureDebut: "08:00",
      heureFin: "17:00",
      dimancheTravaille: false,
      pauseActive: true,
      pauseDuree: 60,
      // Nombre de jours travaillés sur une même semaine (lundi à dimanche) au-delà duquel les
      // jours suivants sont comptés comme heures supplémentaires dans le récapitulatif du livreur.
      joursAvantHeuresSup: 5
    }
  };

  function load() {
    var raw;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      console.warn("localStorage inaccessible :", e);
      raw = null;
    }
    if (!raw) return JSON.parse(JSON.stringify(DEFAULT_DATA));
    try {
      var parsed = JSON.parse(raw);
      // s'assure que toutes les collections existent (rétro-compatibilité)
      Object.keys(DEFAULT_DATA).forEach(function (k) {
        if (parsed[k] === undefined) parsed[k] = JSON.parse(JSON.stringify(DEFAULT_DATA[k]));
      });
      if (migrateData(parsed)) {
        // Les anciennes données ont été converties vers le nouveau format : on sauvegarde
        // tout de suite pour ne pas refaire la migration à chaque chargement.
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed)); } catch (e) { /* silencieux */ }
      }
      return parsed;
    } catch (e) {
      console.error("Données corrompues, réinitialisation.", e);
      return JSON.parse(JSON.stringify(DEFAULT_DATA));
    }
  }

  // -----------------------------------------------------------------------
  // Migrations de données (évolutions du format au fil des versions)
  // -----------------------------------------------------------------------
  // Retourne true si au moins une donnée a été convertie (utile pour savoir s'il faut
  // ré-enregistrer immédiatement).
  function migrateData(data) {
    var changed = false;

    // 1) Un livreur pouvait auparavant être rattaché à un seul entrepôt (entrepotId).
    //    On passe désormais à une liste d'entrepôts (entrepotIds) pour permettre
    //    le rattachement à plusieurs sites.
    data.livreurs.forEach(function (l) {
      if (!Array.isArray(l.entrepotIds)) {
        l.entrepotIds = l.entrepotId ? [l.entrepotId] : [];
        changed = true;
      }
      if (!Array.isArray(l.tags)) { l.tags = []; changed = true; }
    });

    // 2) Les entrepôts peuvent eux aussi changer de nom (renommage, fusion...) : on leur
    //    ajoute la même notion de tags / anciens noms que pour les livreurs.
    data.entrepots.forEach(function (e) {
      if (!Array.isArray(e.tags)) { e.tags = []; changed = true; }
    });

    // 3) Les paliers de primes étaient basés sur un nombre total de livraisons sur la
    //    période. Ils sont désormais basés sur la moyenne quotidienne de bacs livrés
    //    (total de bacs de la période ÷ nombre de jours travaillés). Le seuil existant
    //    est converti en estimation de départ (à ajuster par l'utilisateur si besoin) :
    //    on part de l'hypothèse d'environ 20 jours travaillés sur la période d'origine
    //    et d'environ 2 bacs par livraison.
    data.primesTiers.forEach(function (t) {
      if (t.seuilBacsJour === undefined && t.seuilLivraisons !== undefined) {
        t.seuilBacsJour = Math.round((Number(t.seuilLivraisons) || 0) / 20 * 2);
        changed = true;
      }
    });

    // 4) Chaque ticket de réparation porte désormais un numéro de référence (ex. TCK-0007),
    //    attribué une fois pour toutes à la création et jamais modifié ensuite. On complète
    //    les tickets existants qui n'en ont pas encore, en respectant l'ordre chronologique
    //    de création, puis on s'assure que le compteur de prochain numéro est bien à jour.
    if (!data.settings) { data.settings = {}; changed = true; }
    if (!data.settings.nextTicketNumber) { data.settings.nextTicketNumber = 1; changed = true; }
    var maxTicketNumber = 0;
    data.ticketsReparation.forEach(function (t) {
      if (typeof t.ticketNumber === "number" && t.ticketNumber > maxTicketNumber) maxTicketNumber = t.ticketNumber;
    });
    var ticketsSansNumero = data.ticketsReparation.filter(function (t) { return typeof t.ticketNumber !== "number"; });
    if (ticketsSansNumero.length) {
      ticketsSansNumero.sort(function (a, b) { return (a.dateCreation || "").localeCompare(b.dateCreation || ""); });
      ticketsSansNumero.forEach(function (t) {
        maxTicketNumber++;
        t.ticketNumber = maxTicketNumber;
      });
      changed = true;
    }
    if (data.settings.nextTicketNumber <= maxTicketNumber) {
      data.settings.nextTicketNumber = maxTicketNumber + 1;
      changed = true;
    }

    // 5) Les tickets pouvaient jusqu'ici uniquement représenter une réparation. On introduit une
    //    "nature" de ticket ("reparation" ou "controle", pour les contrôles préventifs effectués
    //    par le réparateur sans demande préalable) : tout ticket existant est considéré comme une
    //    réparation classique.
    data.ticketsReparation.forEach(function (t) {
      if (!t.nature) { t.nature = "reparation"; changed = true; }
    });

    // 6) Les listes de référence utilisées dans les formulaires (catégories de matériel, types de
    //    véhicules, parties contrôlées lors d'un contrôle...) sont désormais personnalisables depuis
    //    la page Annexes. On les initialise avec les valeurs par défaut historiques si absentes.
    if (!data.listesRef) { data.listesRef = JSON.parse(JSON.stringify(DEFAULT_DATA.listesRef)); changed = true; }

    // 7) Le seuil de jours travaillés avant heures supplémentaires est un ajout récent aux
    //    réglages du planning : on le complète avec sa valeur par défaut s'il est absent (les
    //    utilisateurs ayant déjà des réglages de planning n'ont, eux, que ce champ à compléter).
    if (data.planningReglages && data.planningReglages.joursAvantHeuresSup === undefined) {
      data.planningReglages.joursAvantHeuresSup = DEFAULT_DATA.planningReglages.joursAvantHeuresSup;
      changed = true;
    }

    // 8) La liste de référence des justificatifs de retard (page Annexes) est un ajout récent :
    //    on la complète avec ses valeurs par défaut si un listesRef existant ne l'a pas encore.
    if (data.listesRef && !Array.isArray(data.listesRef.motifsRetard)) {
      data.listesRef.motifsRetard = JSON.parse(JSON.stringify(DEFAULT_DATA.listesRef.motifsRetard));
      changed = true;
    }

    // 9) Un retard portait auparavant une simple liste d'identifiants clients (clientIds). Chaque
    //    client concerné a désormais son propre temps de retard et jusqu'à 3 justificatifs : on
    //    convertit vers la nouvelle structure clients: [{clientId, tempsRetard, justifications}].
    (data.retards || []).forEach(function (r) {
      if (!Array.isArray(r.clients)) {
        var ids = Array.isArray(r.clientIds) ? r.clientIds : [];
        r.clients = ids.map(function (id) { return { clientId: id, tempsRetard: null, justifications: [] }; });
        delete r.clientIds;
        changed = true;
      }
    });

    // 10) Les types d'absence (CP, RTT, arrêt maladie, absence injustifiée, jour férié) étaient
    //     auparavant figés dans le code de la page Planning. Ils vivent désormais dans une liste
    //     de référence personnalisable (page Annexes), avec une couleur par type reprise sur la
    //     grille du planning et le récapitulatif "Effectif du jour" : on la complète avec ses
    //     valeurs par défaut si un listesRef existant ne l'a pas encore.
    if (data.listesRef && !Array.isArray(data.listesRef.typesAbsence)) {
      data.listesRef.typesAbsence = JSON.parse(JSON.stringify(DEFAULT_DATA.listesRef.typesAbsence));
      changed = true;
    }

    return changed;
  }

  var _cache = null;

  function getData() {
    if (!_cache) _cache = load();
    return _cache;
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(_cache));
      return true;
    } catch (e) {
      console.error("Impossible de sauvegarder :", e);
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // CRUD générique
  // -----------------------------------------------------------------------

  function list(collection) {
    return getData()[collection] || [];
  }

  function get(collection, id) {
    return list(collection).find(function (x) { return x.id === id; }) || null;
  }

  function add(collection, obj) {
    var data = getData();
    if (!obj.id) obj.id = uid(collection.slice(0, 3));
    obj.createdAt = obj.createdAt || new Date().toISOString();
    data[collection].push(obj);
    save();
    return obj;
  }

  // -----------------------------------------------------------------------
  // Journal d'activité (page Historique)
  // -----------------------------------------------------------------------
  var HISTORIQUE_MAX = 3000; // évite une croissance illimitée du stockage local sur le long terme

  // Enregistre une ligne dans le journal d'activité. `page` est le nom de la section concernée
  // (ex : "Livreurs"), `action` l'un de "ajout" / "modification" / "suppression", `description`
  // un résumé prêt à afficher (ex : "Ajout livreur : Jean Dupont"). Best-effort : une erreur de
  // sauvegarde (quota dépassé) n'interrompt jamais l'opération métier qui vient de réussir.
  function logHistorique(page, action, description) {
    try {
      var data = getData();
      if (!Array.isArray(data.historique)) data.historique = [];
      data.historique.push({
        id: uid("hist"),
        ts: new Date().toISOString(),
        page: page,
        action: action,
        description: description
      });
      if (data.historique.length > HISTORIQUE_MAX) {
        data.historique = data.historique.slice(data.historique.length - HISTORIQUE_MAX);
      }
      save();
    } catch (e) {
      console.warn("Journal d'activité : entrée non enregistrée.", e);
    }
  }

  // Compare deux versions d'un enregistrement sur une liste de champs donnée et renvoie un
  // résumé lisible des champs qui ont changé (ex : "Téléphone : 0102030405, Ville : Lyon"), pour
  // construire une description de modification dans le journal d'activité. `fields` est un objet
  // { nomDeChamp: "Libellé affiché" }. Les valeurs vides/égales sont ignorées ; renvoie "" si
  // rien de notable n'a changé (ex : seule une case à cocher technique a bougé).
  function summarizeFieldChanges(before, after, fields) {
    var parts = [];
    Object.keys(fields).forEach(function (key) {
      var oldVal = before ? before[key] : undefined;
      var newVal = after ? after[key] : undefined;
      var oldStr = (oldVal === undefined || oldVal === null) ? "" : String(oldVal).trim();
      var newStr = (newVal === undefined || newVal === null) ? "" : String(newVal).trim();
      if (oldStr === newStr) return;
      if (!newStr) return; // champ vidé : pas assez parlant pour figurer dans le résumé
      parts.push(fields[key] + " : " + newStr);
    });
    return parts.join(", ");
  }

  // Attribue et consomme le prochain numéro de référence de ticket de réparation
  // (compteur global persistant, jamais réutilisé même après suppression d'un ticket).
  function nextTicketNumber() {
    var data = getData();
    if (!data.settings) data.settings = {};
    if (!data.settings.nextTicketNumber) data.settings.nextTicketNumber = 1;
    var n = data.settings.nextTicketNumber;
    data.settings.nextTicketNumber = n + 1;
    save();
    return n;
  }

  // Insère un lot d'objets en une seule sauvegarde (beaucoup plus rapide qu'un add() par ligne
  // lors d'un import de plusieurs centaines/milliers de lignes).
  function bulkAdd(collection, objects) {
    var data = getData();
    var now = new Date().toISOString();
    objects.forEach(function (obj) {
      if (!obj.id) obj.id = uid(collection.slice(0, 3));
      obj.createdAt = obj.createdAt || now;
      data[collection].push(obj);
    });
    save();
    return objects;
  }

  function update(collection, id, patch) {
    var data = getData();
    var idx = data[collection].findIndex(function (x) { return x.id === id; });
    if (idx === -1) return null;
    data[collection][idx] = Object.assign({}, data[collection][idx], patch, { updatedAt: new Date().toISOString() });
    save();
    return data[collection][idx];
  }

  function remove(collection, id) {
    var data = getData();
    var before = data[collection].length;
    data[collection] = data[collection].filter(function (x) { return x.id !== id; });
    save();
    return data[collection].length < before;
  }

  // Supprime plusieurs enregistrements en une seule sauvegarde (beaucoup plus rapide qu'un
  // remove() par ligne lors d'une suppression groupée portant sur de nombreuses entrées).
  function bulkRemove(collection, ids) {
    var data = getData();
    var idSet = {};
    ids.forEach(function (id) { idSet[id] = true; });
    var before = data[collection].length;
    data[collection] = data[collection].filter(function (x) { return !idSet[x.id]; });
    var removed = before - data[collection].length;
    if (removed) save();
    return removed;
  }

  // -----------------------------------------------------------------------
  // Listes de référence personnalisables (page Annexes) : catégories de matériel, types de
  // véhicules, parties contrôlées lors d'un contrôle véhicule, etc. Chaque liste est un tableau
  // de { key, label } où la clé est stable (référencée par les enregistrements) et le libellé
  // librement modifiable.
  // -----------------------------------------------------------------------
  function listeItems(name) {
    var data = getData();
    if (!data.listesRef || !Array.isArray(data.listesRef[name])) return [];
    return data.listesRef[name];
  }

  function listeLabel(name, key) {
    var item = listeItems(name).find(function (i) { return i.key === key; });
    return item ? item.label : null;
  }

  function addListeItem(name, label, extra) {
    var data = getData();
    if (!data.listesRef) data.listesRef = {};
    if (!Array.isArray(data.listesRef[name])) data.listesRef[name] = [];
    var item = { key: uid("li"), label: label };
    if (extra) Object.keys(extra).forEach(function (k) { item[k] = extra[k]; });
    data.listesRef[name].push(item);
    save();
    return item;
  }

  function updateListeItem(name, key, label) {
    var item = listeItems(name).find(function (i) { return i.key === key; });
    if (item) { item.label = label; save(); }
    return item;
  }

  // Met à jour la couleur (hex) d'une entrée de liste — utilisée pour typesAbsence (page
  // Annexes), reprise sur la grille du planning et le récapitulatif "Effectif du jour".
  function setListeItemColor(name, key, color) {
    var item = listeItems(name).find(function (i) { return i.key === key; });
    if (item) { item.color = color; save(); }
    return item;
  }

  function removeListeItem(name, key) {
    var data = getData();
    if (!data.listesRef || !Array.isArray(data.listesRef[name])) return false;
    var before = data.listesRef[name].length;
    data.listesRef[name] = data.listesRef[name].filter(function (i) { return i.key !== key; });
    save();
    return data.listesRef[name].length < before;
  }

  // -----------------------------------------------------------------------
  // Planning des livreurs : réglages par défaut + accès rapide à l'entrée d'un livreur pour
  // un jour donné (create-or-update en une seule fonction, utilisée aussi bien par l'édition
  // manuelle d'une case que par la génération automatique en masse).
  // -----------------------------------------------------------------------
  function getPlanningReglages() {
    var data = getData();
    if (!data.planningReglages) data.planningReglages = JSON.parse(JSON.stringify(DEFAULT_DATA.planningReglages));
    return data.planningReglages;
  }

  function savePlanningReglages(patch) {
    var r = getPlanningReglages();
    Object.keys(patch).forEach(function (k) { r[k] = patch[k]; });
    save();
    return r;
  }

  function planningEntreeFor(livreurId, dateIso) {
    return list("planningEntrees").find(function (e) { return e.livreurId === livreurId && e.date === dateIso; }) || null;
  }

  function upsertPlanningEntree(livreurId, dateIso, patch) {
    var data = getData();
    var existing = data.planningEntrees.find(function (e) { return e.livreurId === livreurId && e.date === dateIso; });
    if (existing) {
      Object.keys(patch).forEach(function (k) { existing[k] = patch[k]; });
      save();
      return existing;
    }
    var obj = Object.assign({ id: uid("pln"), livreurId: livreurId, date: dateIso, createdAt: new Date().toISOString() }, patch);
    data.planningEntrees.push(obj);
    save();
    return obj;
  }

  // Variante en masse d'upsertPlanningEntree : une seule sauvegarde localStorage pour tout le
  // lot au lieu d'une par case. Indispensable pour la génération automatique du planning (bouton
  // "Proposer planning"), qui peut créer/mettre à jour plusieurs centaines de cases d'un coup —
  // appeler upsertPlanningEntree (donc save()) à chaque case y provoquait un gel du navigateur
  // ("la page ne répond pas"), chaque save() ré-écrivant l'intégralité des données de l'application.
  //
  // La recherche de la case existante utilise un index (objet livreurId|date -> position dans le
  // tableau) construit une seule fois, plutôt qu'un .find() (recherche linéaire) répété pour
  // chaque élément du lot : avec un tableau planningEntrees qui grossit mois après mois, une
  // recherche linéaire par case (donc en O(nombre de cases à écrire × nombre de cases déjà
  // enregistrées)) suffisait à elle seule à geler le navigateur sur une génération portant sur
  // plusieurs mois/plusieurs livreurs, même une fois la sauvegarde elle-même regroupée en un seul
  // appel.
  // Retourne { count, saved } plutôt qu'un simple nombre : `saved` vaut false si
  // localStorage.setItem a échoué (ex : quota de stockage dépassé). Sans cela, un échec de
  // sauvegarde passait inaperçu — l'écran affichait bien les nouvelles cases (elles restent en
  // mémoire) et un message de succès s'affichait, mais rien n'était réellement persisté : au
  // rechargement suivant, tout le travail de génération avait disparu, ce qui pouvait donner
  // l'impression que "la génération ne fonctionne pas".
  function bulkUpsertPlanningEntree(entries) {
    var data = getData();
    var now = new Date().toISOString();
    var index = {};
    data.planningEntrees.forEach(function (e, i) { index[e.livreurId + "|" + e.date] = i; });
    entries.forEach(function (item) {
      var key = item.livreurId + "|" + item.date;
      var idx = index[key];
      if (idx !== undefined) {
        var existing = data.planningEntrees[idx];
        Object.keys(item.patch).forEach(function (k) { existing[k] = item.patch[k]; });
      } else {
        var obj = Object.assign({ id: uid("pln"), livreurId: item.livreurId, date: item.date, createdAt: now }, item.patch);
        data.planningEntrees.push(obj);
        index[key] = data.planningEntrees.length - 1;
      }
    });
    var saved = true;
    if (entries.length) saved = save();
    return { count: entries.length, saved: saved };
  }

  function removePlanningEntree(livreurId, dateIso) {
    var data = getData();
    var before = data.planningEntrees.length;
    data.planningEntrees = data.planningEntrees.filter(function (e) { return !(e.livreurId === livreurId && e.date === dateIso); });
    var removed = data.planningEntrees.length < before;
    if (removed) save();
    return removed;
  }

  // Une date (iso "YYYY-MM-DD") est-elle couverte par une demande d'absence de ce livreur ?
  // Retourne la demande correspondante (la plus récente si plusieurs se chevauchent) ou null.
  function demandeAbsencePour(livreurId, dateIso) {
    var matches = list("demandesAbsence").filter(function (d) {
      return d.livreurId === livreurId && Array.isArray(d.jours) && d.jours.indexOf(dateIso) !== -1;
    });
    if (!matches.length) return null;
    matches.sort(function (a, b) { return (b.dateDemande || "").localeCompare(a.dateDemande || ""); });
    return matches[0];
  }

  // -----------------------------------------------------------------------
  // Retards : au plus un enregistrement de retard par entrée du journal des livraisons
  // (livraisonId), sur le même principe que planningEntreeFor/upsertPlanningEntree.
  // -----------------------------------------------------------------------
  function retardPourLivraison(livraisonId) {
    return list("retards").find(function (r) { return r.livraisonId === livraisonId; }) || null;
  }

  function upsertRetard(livraisonId, patch) {
    var data = getData();
    var existing = data.retards.find(function (r) { return r.livraisonId === livraisonId; });
    if (existing) {
      Object.keys(patch).forEach(function (k) { existing[k] = patch[k]; });
      existing.updatedAt = new Date().toISOString();
      save();
      return existing;
    }
    var obj = Object.assign({ id: uid("ret"), livraisonId: livraisonId, createdAt: new Date().toISOString() }, patch);
    data.retards.push(obj);
    save();
    return obj;
  }

  function removeRetard(livraisonId) {
    var data = getData();
    var before = data.retards.length;
    data.retards = data.retards.filter(function (r) { return r.livraisonId !== livraisonId; });
    var removed = data.retards.length < before;
    if (removed) save();
    return removed;
  }

  // Liste plate des identifiants clients concernés par un retard (chaque client porte son propre
  // temps de retard et jusqu'à 3 justificatifs dans r.clients : [{clientId, tempsRetard, justifications}]).
  function retardClientIds(r) {
    return Array.isArray(r && r.clients) ? r.clients.map(function (c) { return c.clientId; }) : [];
  }

  // -----------------------------------------------------------------------
  // Helpers domaine
  // -----------------------------------------------------------------------

  function entrepotNom(id) {
    var e = get("entrepots", id);
    return e ? e.nom : null;
  }

  function livreurNomComplet(l) {
    if (!l) return "";
    return ((l.prenom || "") + " " + (l.nom || "")).trim();
  }

  function livreurNom(id) {
    var l = get("livreurs", id);
    return l ? livreurNomComplet(l) : null;
  }

  function resolveEntrepotByName(nom) {
    var target = normalizeStr(nom);
    if (!target) return null;
    return list("entrepots").find(function (e) {
      if (normalizeStr(e.nom) === target) return true;
      if (Array.isArray(e.tags) && e.tags.some(function (t) { return normalizeStr(t) === target; })) return true;
      return false;
    }) || null;
  }

  // Indique si un livreur est rattaché à un entrepôt donné (un livreur peut désormais
  // être rattaché à plusieurs entrepôts).
  function livreurAEntrepot(l, entrepotId) {
    return !!l && Array.isArray(l.entrepotIds) && l.entrepotIds.indexOf(entrepotId) !== -1;
  }

  // Un livreur est-il déjà embauché à la date donnée (iso "YYYY-MM-DD") ? Sans date d'embauche
  // renseignée, on considère qu'il l'a toujours été. Utilisé par le Planning (un livreur ne
  // s'affiche pas avant son embauche) et par le contrôle des imports de la page Analyse.
  function livreurEmbaucheLe(l, dateIso) {
    return !!l && (!l.dateEmbauche || dateIso >= l.dateEmbauche);
  }

  // Alertes du contrôle des imports (page Analyse) que l'utilisateur a choisi d'ignorer : table
  // clé -> true conservée dans les réglages, pour que l'alerte ne revienne pas à chaque rendu.
  function getControleIgnores() {
    var data = getData();
    if (!data.settings) data.settings = {};
    if (!data.settings.controleIgnores) data.settings.controleIgnores = {};
    return data.settings.controleIgnores;
  }

  function setControleIgnore(key, flag) {
    var ign = getControleIgnores();
    if (flag) ign[key] = true; else delete ign[key];
    return save();
  }

  function clearControleIgnores() {
    getData().settings.controleIgnores = {};
    return save();
  }

  function resolveLivreurByName(nom) {
    var target = normalizeStr(nom);
    if (!target) return null;
    return list("livreurs").find(function (l) {
      if (normalizeStr(livreurNomComplet(l)) === target) return true;
      if (normalizeStr(l.nom) === target) return true;
      if (Array.isArray(l.tags) && l.tags.some(function (t) { return normalizeStr(t) === target; })) return true;
      return false;
    }) || null;
  }

  function clientNom(id) {
    var c = get("clients", id);
    return c ? c.nom : null;
  }

  // Retrouve un client existant par son nom (comparaison insensible à la casse/aux accents),
  // utilisé lors de la saisie des retards pour proposer la création d'un nouveau client
  // uniquement lorsque le nom tapé ne correspond réellement à aucun client déjà enregistré.
  function resolveClientByName(nom) {
    var target = normalizeStr(nom);
    if (!target) return null;
    return list("clients").find(function (c) { return normalizeStr(c.nom) === target; }) || null;
  }

  // Rattache rétroactivement les livraisons déjà importées (mais non reconnues, livreurId vide)
  // dont le nom brut correspond au nom du livreur ou à l'un de ses tags/anciens noms.
  // Ne touche jamais une livraison déjà rattachée à un autre livreur.
  function reattachOrphanLivraisons(livreurId) {
    var l = get("livreurs", livreurId);
    if (!l) return 0;
    var names = [normalizeStr(livreurNomComplet(l)), normalizeStr(l.nom)];
    if (Array.isArray(l.tags)) l.tags.forEach(function (t) { names.push(normalizeStr(t)); });
    names = names.filter(Boolean);
    if (!names.length) return 0;

    var data = getData();
    var count = 0;
    data.livraisons.forEach(function (r) {
      if (!r.livreurId && r.livreurNom && names.indexOf(normalizeStr(r.livreurNom)) !== -1) {
        r.livreurId = livreurId;
        count++;
      }
    });
    if (count) save();
    return count;
  }

  // Rattache rétroactivement les livraisons déjà importées (mais non reconnues, entrepotId vide)
  // dont le nom brut d'entrepôt correspond au nom de l'entrepôt ou à l'un de ses tags/anciens noms.
  // Ne touche jamais une livraison déjà rattachée à un autre entrepôt.
  function reattachOrphanLivraisonsEntrepot(entrepotId) {
    var e = get("entrepots", entrepotId);
    if (!e) return 0;
    var names = [normalizeStr(e.nom)];
    if (Array.isArray(e.tags)) e.tags.forEach(function (t) { names.push(normalizeStr(t)); });
    names = names.filter(Boolean);
    if (!names.length) return 0;

    var data = getData();
    var count = 0;
    data.livraisons.forEach(function (r) {
      if (!r.entrepotId && r.entrepotNom && names.indexOf(normalizeStr(r.entrepotNom)) !== -1) {
        r.entrepotId = entrepotId;
        count++;
      }
    });
    if (count) save();
    return count;
  }

  // Valeur spéciale utilisable comme entrepotId pour un véhicule / matériel qui n'est pas
  // rattaché à un site précis mais à l'ensemble des entrepôts (ex : matériel mutualisé).
  var ENTREPOT_TOUS = "__TOUS__";

  function vehiculesDisponibles(entrepotId) {
    return list("vehicules").filter(function (v) { return !entrepotId || v.entrepotId === entrepotId || v.entrepotId === ENTREPOT_TOUS; });
  }

  // -----------------------------------------------------------------------
  // Primes (calcul partagé par la page Primes, la page Performance livreurs et
  // la fiche détaillée d'une entrée du journal)
  // -----------------------------------------------------------------------

  // Calcule, pour un livreur et une période donnés, la prime issue du barème ainsi que quelques
  // statistiques d'activité. Le barème est appliqué JOUR PAR JOUR (et non sur une moyenne globale) :
  // pour chaque jour travaillé, le total de bacs livrés ce jour-là détermine le palier le plus élevé
  // atteint, dont le montant est ajouté à la prime. Les ajustements manuels (primesAjustements) pris
  // en compte sont ceux dont la période est ENTIÈREMENT CONTENUE dans [start, end] (periodeDebut >=
  // start ET periodeFin <= end) : un ajustement ponctuel sur une seule journée compte donc dans toute
  // vue englobant ce jour, tandis qu'un ajustement sur un mois entier ne compte que si la période
  // affichée couvre ce mois en entier — évite les comptages partiels/ambigus.
  function computePrimePeriode(livreurId, start, end) {
    var tiers = list("primesTiers").slice().sort(function (a, b) { return a.seuilBacsJour - b.seuilBacsJour; });
    var rows = list("livraisons").filter(function (r) { return r.livreurId === livreurId && r.date >= start && r.date <= end; });
    var jours = {};
    rows.forEach(function (r) { jours[r.date] = (jours[r.date] || 0) + (Number(r.nbBacs) || 0); });
    var dates = Object.keys(jours);
    var totalBacs = dates.reduce(function (a, d) { return a + jours[d]; }, 0);
    var nbJours = dates.length;
    var moyenneJour = nbJours ? totalBacs / nbJours : 0;

    var bareme = 0;
    var tierCounts = {}; // libellé de palier -> nombre de jours où ce palier a été atteint
    dates.forEach(function (d) {
      var bacsJour = jours[d];
      var tierReached = null;
      tiers.forEach(function (t) { if (bacsJour >= t.seuilBacsJour) tierReached = t; });
      if (tierReached) {
        bareme += tierReached.montant;
        tierCounts[tierReached.label] = (tierCounts[tierReached.label] || 0) + 1;
      }
    });
    var tierLabel = tiers.filter(function (t) { return tierCounts[t.label]; })
      .map(function (t) { return t.label + " (" + tierCounts[t.label] + "j)"; })
      .join(", ") || "Aucun";

    var ajustement = list("primesAjustements")
      .filter(function (a) { return a.livreurId === livreurId && a.periodeDebut >= start && a.periodeFin <= end; })
      .reduce(function (s, a) { return s + (Number(a.montant) || 0); }, 0);

    return {
      nbJours: nbJours, bacs: totalBacs, moyenneJour: moyenneJour,
      tierLabel: tierLabel, tierCounts: tierCounts,
      bareme: bareme, ajustement: ajustement, total: bareme + ajustement
    };
  }

  // -----------------------------------------------------------------------
  // Tickets de réparation (véhicules + autre matériel)
  // -----------------------------------------------------------------------

  // Libellé d'affichage d'un véhicule ou d'un matériel (utilisé par les tickets, y compris
  // quand l'élément d'origine a depuis été supprimé — d'où le fallback sur ticket.materielLabel).
  function materielLabel(type, id) {
    if (type === "vehicule") {
      var v = get("vehicules", id);
      return v ? (v.plaque + (v.type ? " (" + v.type + ")" : "")) : null;
    }
    var m = get("materiels", id);
    return m ? m.nom : null;
  }

  // Ouvre ou fait évoluer un ticket : à chaque création/changement de statut d'un ticket,
  // on recalcule l'état du véhicule/matériel concerné à partir de TOUS ses tickets encore
  // ouverts (statut "nouveau" ou "en_cours") :
  //  - aucun ticket ouvert            -> état nominal (véhicule "service" / matériel "bon")
  //  - au moins un ticket ouvert      -> état dégradé (véhicule "maintenance" / matériel "moyen")
  //  - un ticket ouvert marqué "immobilise" (panne bloquante) -> état le plus grave
  //    (véhicule "hors_service" / matériel "a_remplacer"), qui prime sur les autres tickets ouverts.
  // Un changement d'état fait manuellement sur la fiche véhicule/matériel n'est écrasé qu'au
  // prochain événement sur un ticket (création, déplacement, clôture, suppression) : il n'y a
  // pas de recalcul en continu.
  function recalcEtatMateriel(type, id) {
    var ouverts = list("ticketsReparation").filter(function (t) {
      return t.materielType === type && t.materielId === id && (t.statut === "nouveau" || t.statut === "en_cours");
    });
    var immobilise = ouverts.some(function (t) { return !!t.immobilise; });
    if (type === "vehicule") {
      var statut = immobilise ? "hors_service" : (ouverts.length ? "maintenance" : "service");
      update("vehicules", id, { statut: statut });
    } else {
      var etat = immobilise ? "a_remplacer" : (ouverts.length ? "moyen" : "bon");
      update("materiels", id, { etat: etat });
    }
  }

  // -----------------------------------------------------------------------
  // Export / import de sauvegarde JSON (portabilité des données)
  // -----------------------------------------------------------------------

  function exportBackup() {
    var data = getData();
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "livraison-manager-sauvegarde-" + todayISO() + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function importBackup(file, callback) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var parsed = JSON.parse(reader.result);
        Object.keys(DEFAULT_DATA).forEach(function (k) {
          if (parsed[k] === undefined) parsed[k] = JSON.parse(JSON.stringify(DEFAULT_DATA[k]));
        });
        _cache = parsed;
        save();
        callback(null);
      } catch (e) {
        callback(e);
      }
    };
    reader.onerror = function () { callback(new Error("Lecture du fichier impossible")); };
    reader.readAsText(file);
  }

  function resetAll() {
    _cache = JSON.parse(JSON.stringify(DEFAULT_DATA));
    save();
  }

  // -----------------------------------------------------------------------
  // Données de démonstration (insérées uniquement si la base est vide)
  // -----------------------------------------------------------------------

  function seedIfEmpty() {
    var data = getData();
    if (data.entrepots.length > 0) return false;

    var entrepots = [
      { id: uid("ent"), nom: "Entrepôt Paris Nord", adresse: "12 rue des Docks", ville: "Saint-Denis", codePostal: "93200", responsable: "Isabelle Roy", telephone: "01 42 55 10 20", email: "paris-nord@livraison.fr", capacite: 4000, x: 55, y: 21, rayonKm: 45, horaires: "6h - 20h", tags: [], notes: "" },
      { id: uid("ent"), nom: "Entrepôt Lyon", adresse: "8 avenue Jean Jaurès", ville: "Vénissieux", codePostal: "69200", responsable: "Karim Belkacem", telephone: "04 78 90 33 10", email: "lyon@livraison.fr", capacite: 2600, x: 76, y: 58, rayonKm: 35, horaires: "6h30 - 19h30", tags: [], notes: "" },
      { id: uid("ent"), nom: "Entrepôt Marseille", adresse: "45 chemin de la Madrague", ville: "Marseille", codePostal: "13015", responsable: "Nadia Fontaine", telephone: "04 91 60 22 18", email: "marseille@livraison.fr", capacite: 2200, x: 80, y: 86, rayonKm: 30, horaires: "6h - 19h", tags: [], notes: "" },
      { id: uid("ent"), nom: "Entrepôt Lille", adresse: "3 rue de l'Industrie", ville: "Lille", codePostal: "59000", responsable: "Thomas Lefebvre", telephone: "03 20 45 12 00", email: "lille@livraison.fr", capacite: 1800, x: 62, y: 5, rayonKm: 40, horaires: "6h - 19h", tags: [], notes: "" },
      { id: uid("ent"), nom: "Entrepôt Bordeaux", adresse: "22 quai de Brazza", ville: "Bordeaux", codePostal: "33100", responsable: "Julie Marchand", telephone: "05 56 40 15 60", email: "bordeaux@livraison.fr", capacite: 1900, x: 34, y: 68, rayonKm: 40, horaires: "6h30 - 19h", tags: [], notes: "" }
    ];
    entrepots.forEach(function (e) { data.entrepots.push(e); });

    var vehicules = [
      { id: uid("veh"), plaque: "AB-123-CD", type: "camionnette", entrepotId: entrepots[0].id, statut: "service", km: 48200, dateAchat: "2023-03-14", prochainEntretien: "2026-08-01", notes: "" },
      { id: uid("veh"), plaque: "EF-456-GH", type: "camionnette", entrepotId: entrepots[0].id, statut: "service", km: 61000, dateAchat: "2022-06-02", prochainEntretien: "2026-07-20", notes: "" },
      { id: uid("veh"), plaque: "IJ-789-KL", type: "velo_cargo", entrepotId: entrepots[0].id, statut: "maintenance", km: 3200, dateAchat: "2024-01-10", prochainEntretien: "2026-07-15", notes: "Frein arrière à revoir" },
      { id: uid("veh"), plaque: "MN-321-OP", type: "camion", entrepotId: entrepots[1].id, statut: "service", km: 92500, dateAchat: "2021-09-01", prochainEntretien: "2026-09-05", notes: "" },
      { id: uid("veh"), plaque: "QR-654-ST", type: "camionnette", entrepotId: entrepots[1].id, statut: "service", km: 34000, dateAchat: "2023-11-20", prochainEntretien: "2026-10-01", notes: "" },
      { id: uid("veh"), plaque: "UV-987-WX", type: "scooter", entrepotId: entrepots[2].id, statut: "service", km: 15400, dateAchat: "2024-02-18", prochainEntretien: "2026-08-12", notes: "" },
      { id: uid("veh"), plaque: "YZ-159-AB", type: "camionnette", entrepotId: entrepots[2].id, statut: "hors_service", km: 78000, dateAchat: "2020-05-05", prochainEntretien: "2026-07-10", notes: "Panne moteur, devis en cours" },
      { id: uid("veh"), plaque: "CD-753-EF", type: "camionnette", entrepotId: entrepots[3].id, statut: "service", km: 25600, dateAchat: "2024-04-22", prochainEntretien: "2026-11-01", notes: "" },
      { id: uid("veh"), plaque: "GH-951-IJ", type: "camion", entrepotId: entrepots[4].id, statut: "service", km: 55200, dateAchat: "2022-12-01", prochainEntretien: "2026-09-18", notes: "" }
    ];
    vehicules.forEach(function (v) { data.vehicules.push(v); });

    var livreurs = [
      // Jean est rattaché à 2 entrepôts (Paris Nord + Lille) pour illustrer le rattachement multi-entrepôts.
      { id: uid("liv"), prenom: "Jean", nom: "Dupont", telephone: "06 12 34 56 78", email: "jean.dupont@mail.fr", entrepotIds: [entrepots[0].id, entrepots[3].id], vehiculeId: vehicules[0].id, statut: "actif", dateEmbauche: "2021-04-01", permis: "B", zone: "Nord Paris / Saint-Denis", tags: [], notes: "" },
      { id: uid("liv"), prenom: "Marie", nom: "Curie", telephone: "06 22 33 44 55", email: "marie.curie@mail.fr", entrepotIds: [entrepots[0].id], vehiculeId: vehicules[1].id, statut: "actif", dateEmbauche: "2022-01-15", permis: "B", zone: "Paris intra-muros", tags: [], notes: "" },
      { id: uid("liv"), prenom: "Paul", nom: "Martin", telephone: "06 33 44 55 66", email: "paul.martin@mail.fr", entrepotIds: [entrepots[0].id], vehiculeId: vehicules[2].id, statut: "conge", dateEmbauche: "2023-06-10", permis: "A2", zone: "Centre Paris", tags: [], notes: "" },
      { id: uid("liv"), prenom: "Sophie", nom: "Bernard", telephone: "06 44 55 66 77", email: "sophie.bernard@mail.fr", entrepotIds: [entrepots[1].id], vehiculeId: vehicules[3].id, statut: "actif", dateEmbauche: "2020-09-01", permis: "C", zone: "Lyon agglomération", tags: [], notes: "" },
      { id: uid("liv"), prenom: "Ahmed", nom: "Benali", telephone: "06 55 66 77 88", email: "ahmed.benali@mail.fr", entrepotIds: [entrepots[1].id], vehiculeId: vehicules[4].id, statut: "actif", dateEmbauche: "2022-03-22", permis: "B", zone: "Villeurbanne / Bron", tags: [], notes: "" },
      { id: uid("liv"), prenom: "Chloé", nom: "Petit", telephone: "06 66 77 88 99", email: "chloe.petit@mail.fr", entrepotIds: [entrepots[2].id], vehiculeId: vehicules[5].id, statut: "actif", dateEmbauche: "2023-02-14", permis: "A", zone: "Marseille Nord", tags: [], notes: "" },
      { id: uid("liv"), prenom: "Nicolas", nom: "Girard", telephone: "06 77 88 99 00", email: "nicolas.girard@mail.fr", entrepotIds: [entrepots[2].id], vehiculeId: null, statut: "arret", dateEmbauche: "2021-11-05", permis: "B", zone: "Marseille Sud", tags: [], notes: "Arrêt maladie jusqu'au 15/07" },
      { id: uid("liv"), prenom: "Laura", nom: "Simon", telephone: "06 88 99 00 11", email: "laura.simon@mail.fr", entrepotIds: [entrepots[3].id], vehiculeId: vehicules[7].id, statut: "actif", dateEmbauche: "2023-08-01", permis: "B", zone: "Lille métropole", tags: [], notes: "" },
      { id: uid("liv"), prenom: "Thomas", nom: "Michel", telephone: "06 99 00 11 22", email: "thomas.michel@mail.fr", entrepotIds: [entrepots[4].id], vehiculeId: vehicules[8].id, statut: "actif", dateEmbauche: "2020-05-18", permis: "C", zone: "Bordeaux rive droite", tags: [], notes: "" }
    ];
    livreurs.forEach(function (l) { data.livreurs.push(l); });

    var materiels = [
      { id: uid("mat"), nom: "Bacs de livraison pliables 60L", categorie: "bacs", quantite: 850, entrepotId: entrepots[0].id, etat: "bon", notes: "" },
      { id: uid("mat"), nom: "Bacs isothermes", categorie: "bacs", quantite: 220, entrepotId: entrepots[0].id, etat: "bon", notes: "" },
      { id: uid("mat"), nom: "Diables / chariots", categorie: "chariots", quantite: 34, entrepotId: entrepots[0].id, etat: "moyen", notes: "6 unités à réviser" },
      { id: uid("mat"), nom: "Scanners codes-barres", categorie: "scanners", quantite: 18, entrepotId: entrepots[0].id, etat: "bon", notes: "" },
      { id: uid("mat"), nom: "Bacs de livraison pliables 60L", categorie: "bacs", quantite: 640, entrepotId: entrepots[1].id, etat: "bon", notes: "" },
      { id: uid("mat"), nom: "Diables / chariots", categorie: "chariots", quantite: 21, entrepotId: entrepots[1].id, etat: "bon", notes: "" },
      { id: uid("mat"), nom: "Scanners codes-barres", categorie: "scanners", quantite: 12, entrepotId: entrepots[1].id, etat: "a_remplacer", notes: "3 écrans fissurés" },
      { id: uid("mat"), nom: "Bacs de livraison pliables 60L", categorie: "bacs", quantite: 510, entrepotId: entrepots[2].id, etat: "moyen", notes: "" },
      { id: uid("mat"), nom: "Gilets et EPI", categorie: "autre", quantite: 60, entrepotId: entrepots[2].id, etat: "bon", notes: "" },
      { id: uid("mat"), nom: "Bacs de livraison pliables 60L", categorie: "bacs", quantite: 380, entrepotId: entrepots[3].id, etat: "bon", notes: "" },
      { id: uid("mat"), nom: "Bacs de livraison pliables 60L", categorie: "bacs", quantite: 400, entrepotId: entrepots[4].id, etat: "bon", notes: "" },
      { id: uid("mat"), nom: "Diables / chariots", categorie: "chariots", quantite: 15, entrepotId: entrepots[4].id, etat: "bon", notes: "" }
    ];
    materiels.forEach(function (m) { data.materiels.push(m); });

    // Génère ~2.5 mois de livraisons de démonstration
    var rand = mulberry32(1234);
    var startDate = new Date();
    startDate.setDate(startDate.getDate() - 75);
    for (var d = 0; d < 75; d++) {
      var date = new Date(startDate);
      date.setDate(date.getDate() + d);
      var iso = date.toISOString().slice(0, 10);
      var dow = date.getDay();
      if (dow === 0) continue; // pas de livraison le dimanche
      entrepots.forEach(function (ent) {
        var entLivreurs = livreurs.filter(function (l) { return l.entrepotIds.indexOf(ent.id) !== -1 && l.statut === "actif"; });
        entLivreurs.forEach(function (l) {
          if (rand() < 0.12) return; // jour d'absence occasionnel
          var nbLiv = Math.round(18 + rand() * 42);
          var nbBacs = Math.round(nbLiv * (1.6 + rand() * 0.8));
          var km = Math.round((40 + rand() * 90) * 10) / 10;
          var incidents = rand() < 0.08 ? 1 : (rand() < 0.015 ? 2 : 0);
          data.livraisons.push({
            id: uid("livr"),
            date: iso,
            entrepotId: ent.id,
            entrepotNom: ent.nom,
            livreurId: l.id,
            livreurNom: livreurNomComplet(l),
            nbLivraisons: nbLiv,
            nbBacs: nbBacs,
            km: km,
            incidents: incidents,
            commentaire: "",
            source: "demo"
          });
        });
      });
    }

    // Paliers basés sur la moyenne quotidienne de bacs livrés (bacs de la période ÷ jours travaillés).
    data.primesTiers = [
      { id: uid("pt"), seuilBacsJour: 60, montant: 40, label: "Palier 1" },
      { id: uid("pt"), seuilBacsJour: 90, montant: 90, label: "Palier 2" },
      { id: uid("pt"), seuilBacsJour: 120, montant: 150, label: "Palier 3" }
    ];

    // Tickets de réparation de démonstration, cohérents avec les statuts déjà seedés
    // ci-dessus (ex : IJ-789-KL est en "maintenance" -> un ticket "en_cours" lui correspond).
    function isoDaysAgo(n) { var d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); }
    data.ticketsReparation = [
      {
        id: uid("tik"), ticketNumber: 3, nature: "reparation", materielType: "vehicule", materielId: vehicules[2].id, materielLabel: vehicules[2].plaque,
        titre: "Frein arrière à réviser", description: "Bruit anormal au freinage signalé par le livreur.",
        priorite: "normale", immobilise: false, statut: "en_cours",
        creePar: "Isabelle Roy", dateCreation: isoDaysAgo(10),
        reparateur: "Cycles Dupuis", dateDebut: isoDaysAgo(7), dateFin: "", cout: "", compteRendu: ""
      },
      {
        id: uid("tik"), ticketNumber: 6, nature: "reparation", materielType: "vehicule", materielId: vehicules[6].id, materielLabel: vehicules[6].plaque,
        titre: "Panne moteur", description: "Le véhicule ne démarre plus, devis en cours chez le garagiste.",
        priorite: "urgente", immobilise: true, statut: "nouveau",
        creePar: "Nadia Fontaine", dateCreation: isoDaysAgo(3),
        reparateur: "", dateDebut: "", dateFin: "", cout: "", compteRendu: ""
      },
      {
        id: uid("tik"), ticketNumber: 5, nature: "reparation", materielType: "materiel", materielId: materiels[6].id, materielLabel: materiels[6].nom,
        titre: "3 scanners à écran fissuré", description: "Écrans fissurés, lecture des codes-barres devenue impossible sur 3 appareils.",
        priorite: "haute", immobilise: true, statut: "nouveau",
        creePar: "Karim Belkacem", dateCreation: isoDaysAgo(5),
        reparateur: "", dateDebut: "", dateFin: "", cout: "", compteRendu: ""
      },
      {
        id: uid("tik"), ticketNumber: 4, nature: "reparation", materielType: "materiel", materielId: materiels[2].id, materielLabel: materiels[2].nom,
        titre: "Révision de 6 chariots (roues à changer)", description: "Roulettes usées sur 6 diables, gênant la manutention.",
        priorite: "normale", immobilise: false, statut: "en_cours",
        creePar: "Isabelle Roy", dateCreation: isoDaysAgo(6),
        reparateur: "Atelier interne", dateDebut: isoDaysAgo(4), dateFin: "", cout: "", compteRendu: ""
      },
      {
        id: uid("tik"), ticketNumber: 1, nature: "reparation", materielType: "vehicule", materielId: vehicules[0].id, materielLabel: vehicules[0].plaque,
        titre: "Révision des 50 000 km", description: "Révision constructeur programmée.",
        priorite: "normale", immobilise: false, statut: "termine",
        creePar: "Isabelle Roy", dateCreation: isoDaysAgo(20),
        reparateur: "Garage Central Saint-Denis", dateDebut: isoDaysAgo(19), dateFin: isoDaysAgo(16),
        cout: 340, compteRendu: "Vidange, plaquettes de frein changées, contrôle général effectué. Véhicule remis en service."
      },
      {
        id: uid("tik"), ticketNumber: 2, nature: "reparation", materielType: "vehicule", materielId: vehicules[8].id, materielLabel: vehicules[8].plaque,
        titre: "Bruit suspect signalé", description: "Bruit inhabituel signalé par le livreur au niveau de la boîte de vitesses.",
        priorite: "basse", immobilise: false, statut: "annule",
        creePar: "Julie Marchand", dateCreation: isoDaysAgo(15),
        reparateur: "Garage Sud-Ouest Auto", dateDebut: isoDaysAgo(14), dateFin: isoDaysAgo(14),
        cout: "", compteRendu: "Aucun défaut trouvé après contrôle, ticket annulé."
      }
    ];
    if (!data.settings) data.settings = {};
    data.settings.nextTicketNumber = 7;

    save();
    return true;
  }

  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // -----------------------------------------------------------------------
  // Export public
  // -----------------------------------------------------------------------

  global.DB = {
    uid: uid,
    normalizeStr: normalizeStr,
    todayISO: todayISO,
    fmtEUR: fmtEUR,
    fmtNum: fmtNum,
    fmtDate: fmtDate,
    fmtTicketRef: fmtTicketRef,
    nextTicketNumber: nextTicketNumber,
    getData: getData,
    save: save,
    list: list,
    get: get,
    add: add,
    bulkAdd: bulkAdd,
    update: update,
    remove: remove,
    bulkRemove: bulkRemove,
    listeItems: listeItems,
    listeLabel: listeLabel,
    addListeItem: addListeItem,
    updateListeItem: updateListeItem,
    removeListeItem: removeListeItem,
    setListeItemColor: setListeItemColor,
    logHistorique: logHistorique,
    summarizeFieldChanges: summarizeFieldChanges,
    getPlanningReglages: getPlanningReglages,
    savePlanningReglages: savePlanningReglages,
    planningEntreeFor: planningEntreeFor,
    upsertPlanningEntree: upsertPlanningEntree,
    bulkUpsertPlanningEntree: bulkUpsertPlanningEntree,
    removePlanningEntree: removePlanningEntree,
    demandeAbsencePour: demandeAbsencePour,
    retardPourLivraison: retardPourLivraison,
    upsertRetard: upsertRetard,
    removeRetard: removeRetard,
    retardClientIds: retardClientIds,
    entrepotNom: entrepotNom,
    livreurNom: livreurNom,
    livreurNomComplet: livreurNomComplet,
    clientNom: clientNom,
    resolveClientByName: resolveClientByName,
    resolveEntrepotByName: resolveEntrepotByName,
    resolveLivreurByName: resolveLivreurByName,
    livreurAEntrepot: livreurAEntrepot,
    livreurEmbaucheLe: livreurEmbaucheLe,
    getControleIgnores: getControleIgnores,
    setControleIgnore: setControleIgnore,
    clearControleIgnores: clearControleIgnores,
    reattachOrphanLivraisons: reattachOrphanLivraisons,
    reattachOrphanLivraisonsEntrepot: reattachOrphanLivraisonsEntrepot,
    ENTREPOT_TOUS: ENTREPOT_TOUS,
    vehiculesDisponibles: vehiculesDisponibles,
    computePrimePeriode: computePrimePeriode,
    materielLabel: materielLabel,
    recalcEtatMateriel: recalcEtatMateriel,
    exportBackup: exportBackup,
    importBackup: importBackup,
    resetAll: resetAll,
    seedIfEmpty: seedIfEmpty
  };
})(typeof window !== "undefined" ? window : globalThis);


/* ==== js/nav.js ==== */
/*!
 * nav.js - Construit la coquille de l'application (sidebar + barre du haut)
 * et fournit un petit jeu d'icônes SVG en ligne (aucune dépendance externe / police d'icônes).
 */
(function (global) {
  "use strict";

  var ICONS = {
    logo: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 16.5V7.8c0-.5.3-.9.8-1L11.2 4c.5-.2 1.1-.2 1.6 0l7.4 2.8c.5.2.8.6.8 1v8.7"/><path d="M3 16.5 12 20l9-3.5"/><path d="M12 20v-8"/><path d="M3 8.5 12 12l9-3.5"/></svg>',
    dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
    entrepot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21V10l9-6 9 6v11"/><path d="M3 10h18"/><path d="M9 21v-6h6v6"/></svg>',
    livreur: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.2"/><path d="M4.5 21c1-4 4-6 7.5-6s6.5 2 7.5 6"/></svg>',
    materiel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8V6.5a1 1 0 0 0-.5-.87l-8-4.5a1 1 0 0 0-1 0l-8 4.5a1 1 0 0 0-.5.87V17.5a1 1 0 0 0 .5.87l8 4.5a1 1 0 0 0 1 0l8-4.5a1 1 0 0 0 .5-.87V16"/><path d="M3.3 7 12 12l8.7-5"/><path d="M12 22V12"/><path d="M17.5 4.5 8 10"/></svg>',
    analyse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V10"/><path d="M11 20V4"/><path d="M18 20v-7"/><path d="M2.5 20h19"/></svg>',
    zones: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.4"/></svg>',
    primes: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9 9.5c0-1 1-1.8 3-1.8s3 .8 3 1.6-1 1.3-3 1.7-3 .9-3 1.8 1 1.7 3 1.7 3-.7 3-1.7"/></svg>',
    menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M3 12h18"/><path d="M3 18h18"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 21h16"/></svg>',
    upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21V9"/><path d="m7 14 5-5 5 5"/><path d="M4 3h16"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>',
    truck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="6" width="13" height="11"/><path d="M14 10h4l3 3.5V17h-7z"/><circle cx="6" cy="19" r="1.6"/><circle cx="17.5" cy="19" r="1.6"/></svg>',
    box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8V6.5a1 1 0 0 0-.5-.87l-8-4.5a1 1 0 0 0-1 0l-8 4.5a1 1 0 0 0-.5.87V17.5a1 1 0 0 0 .5.87l8 4.5a1 1 0 0 0 1 0l8-4.5a1 1 0 0 0 .5-.87V16"/><path d="M3.3 7 12 12l8.7-5"/><path d="M12 22V12"/></svg>',
    euro: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.5 6.5A6.5 6.5 0 1 0 18.5 17.5"/><path d="M4 10h11"/><path d="M4 14h9"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 6-12 12"/><path d="m6 6 12 12"/></svg>',
    empty: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8V6.5a1 1 0 0 0-.5-.87l-8-4.5a1 1 0 0 0-1 0l-8 4.5a1 1 0 0 0-.5.87V17.5a1 1 0 0 0 .5.87l8 4.5a1 1 0 0 0 1 0l8-4.5a1 1 0 0 0 .5-.87V16"/><path d="M3.3 7 12 12l8.7-5"/><path d="M12 22V12"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 7"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></svg>',
    tag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.6 2.4H5a2.6 2.6 0 0 0-2.6 2.6v7.6c0 .7.3 1.3.8 1.8l9 9c1 1 2.6 1 3.6 0l6.2-6.2c1-1 1-2.6 0-3.6l-9-9c-.5-.5-1.1-.8-1.8-.8Z"/><circle cx="7.6" cy="7.6" r="1.4" fill="currentColor" stroke="none"/></svg>',
    wrench: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 0-5.6 4.6L2.8 17.2a1.8 1.8 0 0 0 2.5 2.5l6.3-6.3a4 4 0 0 0 4.6-5.6l-2.6 2.6-2.4-.6-.6-2.4Z"/></svg>',
    dragHandle: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="8" cy="6" r="1.6"/><circle cx="16" cy="6" r="1.6"/><circle cx="8" cy="12" r="1.6"/><circle cx="16" cy="12" r="1.6"/><circle cx="8" cy="18" r="1.6"/><circle cx="16" cy="18" r="1.6"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1.4 12S5 5.2 12 5.2 22.6 12 22.6 12 19 18.8 12 18.8 1.4 12 1.4 12Z"/><circle cx="12" cy="12" r="3.2"/></svg>',
    trend: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17 9.5 10.5l4 4L21 6.5"/><path d="M21 12V6.5h-5.5"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 3v4"/><path d="M16 3v4"/></svg>',
    wand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20 16 8"/><path d="M14 4l.8 1.7L16.5 6.5l-1.7.8-.8 1.7-.8-1.7-1.7-.8 1.7-.8Z"/><path d="M19.5 11l.6 1.3 1.3.6-1.3.6-.6 1.3-.6-1.3-1.3-.6 1.3-.6Z"/></svg>',
    chevronLeft: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>',
    chevronRight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
    retard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="13" r="8"/><path d="M11 9v4l2.6 1.8"/><path d="M8.5 2.5h5"/><path d="M20 6l1.5-1.5"/></svg>',
    clients: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8.5" cy="7.5" r="3"/><path d="M2 19.5c.8-3.4 3.2-5.3 6.5-5.3s5.7 1.9 6.5 5.3"/><circle cx="17" cy="8.3" r="2.3"/><path d="M15.6 14.4c2.2.5 3.8 2.1 4.4 4.6"/></svg>',
    historique: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 8v4l3 2"/></svg>',
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4h3.4l1.6 4.3-2 1.6a11.4 11.4 0 0 0 5.6 5.6l1.6-2 4.3 1.6v3.4a1.6 1.6 0 0 1-1.7 1.6A16.7 16.7 0 0 1 2.9 5.7 1.6 1.6 0 0 1 4.5 4Z"/></svg>'
  };

  var NAV_ITEMS = [
    { key: "dashboard", href: "#/dashboard", label: "Tableau de bord", icon: "dashboard" },
    { key: "entrepots", href: "#/entrepots", label: "Entrepôts", icon: "entrepot" },
    { key: "livreurs", href: "#/livreurs", label: "Livreurs", icon: "livreur" },
    { key: "planning", href: "#/planning", label: "Planning", icon: "calendar" },
    { key: "performance", href: "#/performance", label: "Performance livreurs", icon: "trend" },
    { key: "materiel", href: "#/materiel", label: "Matériel", icon: "materiel" },
    { key: "reparations", href: "#/reparations", label: "Réparations", icon: "wrench" },
    { key: "analyse", href: "#/analyse", label: "Analyse", icon: "analyse" },
    { key: "retards", href: "#/retards", label: "Retards", icon: "retard" },
    { key: "clients", href: "#/clients", label: "Clients", icon: "clients" },
    { key: "zones", href: "#/zones", label: "Zones géographiques", icon: "zones" },
    { key: "primes", href: "#/primes", label: "Primes", icon: "primes" },
    { key: "annexes", href: "#/annexes", label: "Annexes", icon: "tag" },
    { key: "historique", href: "#/historique", label: "Historique", icon: "historique" }
  ];

  function icon(name) {
    return ICONS[name] || "";
  }

  function initShell(opts) {
    opts = opts || {};
    var shell = document.getElementById("appShell");
    if (!shell) return null;

    var navHtml = NAV_ITEMS.map(function (item) {
      var active = item.key === opts.active ? " active" : "";
      return '<a href="' + item.href + '" class="' + active.trim() + '">' + icon(item.icon) + '<span>' + item.label + "</span></a>";
    }).join("");

    shell.innerHTML =
      '<aside class="sidebar" id="sidebar">' +
        '<div class="sidebar-brand"><div class="logo-mark">' + icon("logo") + '</div><div><div>LivraisonManager</div><span class="brand-sub">Gestion 100% hors-ligne</span></div></div>' +
        '<nav class="sidebar-nav">' +
          '<div class="nav-section-label">Exploitation</div>' +
          navHtml +
        '</nav>' +
        '<div class="sidebar-footer">' +
          '<div class="flex gap-8" style="margin-bottom:8px;">' +
            '<button class="btn btn-ghost btn-sm" id="btnExport" style="color:#b7bede;" title="Exporter une sauvegarde JSON">' + icon("download") + " Sauvegarder</button>" +
          '</div>' +
          '<div class="flex gap-8">' +
            '<button class="btn btn-ghost btn-sm" id="btnImport" style="color:#b7bede;" title="Restaurer une sauvegarde JSON">' + icon("upload") + " Restaurer</button>" +
            '<input type="file" id="importFile" accept="application/json" style="display:none" />' +
          '</div>' +
          '<div style="margin-top:10px;">Données stockées localement dans ce navigateur.</div>' +
        '</div>' +
      '</aside>' +
      '<div class="main-area">' +
        '<header class="topbar">' +
          '<div class="flex gap-14" style="align-items:center;">' +
            '<button class="menu-toggle" id="menuToggle">' + icon("menu") + '</button>' +
            '<div><h1>' + (opts.title || "") + '</h1>' + (opts.subtitle ? '<div class="topbar-meta">' + opts.subtitle + '</div>' : '') + '</div>' +
          '</div>' +
          '<div class="topbar-actions" id="topbarActions"></div>' +
        '</header>' +
        '<main class="content" id="content"></main>' +
      '</div>';

    var menuToggle = document.getElementById("menuToggle");
    var sidebar = document.getElementById("sidebar");
    if (menuToggle && sidebar) {
      menuToggle.addEventListener("click", function () { sidebar.classList.toggle("open"); });
    }

    var btnExport = document.getElementById("btnExport");
    if (btnExport) btnExport.addEventListener("click", function () { global.DB.exportBackup(); toast("Sauvegarde téléchargée.", "success"); });

    var btnImport = document.getElementById("btnImport");
    var importFile = document.getElementById("importFile");
    if (btnImport && importFile) {
      btnImport.addEventListener("click", function () { importFile.click(); });
      importFile.addEventListener("change", function (e) {
        var file = e.target.files[0];
        if (!file) return;
        // Utilise la modale maison (confirmDialog) plutôt que le confirm() natif du navigateur :
        // ce dernier est bloqué / répond silencieusement "annulé" dans certains contextes web-view
        // sandboxés (ex : ouverture du fichier HTML depuis l'app Fichiers sur iPhone), ce qui
        // empêchait la restauration de se lancer sans aucun message d'erreur pour l'utilisateur.
        confirmDialog(
          "Restaurer cette sauvegarde remplacera <strong>toutes les données actuelles</strong>. Continuer ?",
          function () {
            global.DB.importBackup(file, function (err) {
              if (err) { toast("Erreur : fichier de sauvegarde invalide.", "danger"); return; }
              toast("Sauvegarde restaurée. Rechargement…", "success");
              setTimeout(function () { location.reload(); }, 900);
            });
          }
        );
        importFile.value = ""; // permet de resélectionner le même fichier si besoin (ex : après annulation)
      });
    }

    return document.getElementById("content");
  }

  function toast(message, type) {
    var stack = document.querySelector(".toast-stack");
    if (!stack) {
      stack = document.createElement("div");
      stack.className = "toast-stack";
      document.body.appendChild(stack);
    }
    var el = document.createElement("div");
    el.className = "toast" + (type ? " toast-" + type : "");
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(function () {
      el.style.transition = "opacity 200ms ease";
      el.style.opacity = "0";
      setTimeout(function () { el.remove(); }, 220);
    }, 2600);
  }

  // ---------------------------------------------------------------------
  // Modal générique réutilisable par toutes les pages
  // ---------------------------------------------------------------------
  function openModal(opts) {
    opts = opts || {};
    closeModal(); // une seule modale à la fois

    var overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "activeModalOverlay";

    var modal = document.createElement("div");
    modal.className = "modal" + (opts.wide ? " modal-wide" : "");

    modal.innerHTML =
      '<div class="modal-header"><h2>' + (opts.title || "") + '</h2>' +
      '<button class="modal-close" type="button" aria-label="Fermer">' + icon("close") + '</button></div>' +
      '<div class="modal-body">' + (opts.bodyHtml || "") + '</div>' +
      (opts.footerHtml ? '<div class="modal-footer">' + opts.footerHtml + '</div>' : '');

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    overlay.querySelector(".modal-close").addEventListener("click", closeModal);
    overlay.addEventListener("mousedown", function (e) { if (e.target === overlay) closeModal(); });
    document.addEventListener("keydown", escHandler);

    if (typeof opts.onMount === "function") opts.onMount(modal);
    return { overlay: overlay, modal: modal };
  }

  function escHandler(e) {
    if (e.key === "Escape") closeModal();
  }

  function closeModal() {
    var existing = document.getElementById("activeModalOverlay");
    if (existing) existing.remove();
    document.removeEventListener("keydown", escHandler);
  }

  function confirmDialog(message, onConfirm) {
    openModal({
      title: "Confirmation",
      bodyHtml: '<p style="margin:0;">' + message + '</p>',
      footerHtml: '<button class="btn btn-secondary" id="cdCancel">Annuler</button><button class="btn btn-danger" id="cdOk">Confirmer</button>',
      onMount: function (modal) {
        modal.querySelector("#cdCancel").addEventListener("click", closeModal);
        modal.querySelector("#cdOk").addEventListener("click", function () { closeModal(); onConfirm(); });
      }
    });
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return str.toString()
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // ---------------------------------------------------------------------
  // Export PDF : l'application restant 100% hors-ligne et sans aucune
  // dépendance externe, on ne génère pas de binaire PDF nous-mêmes. On ouvre
  // à la place un document HTML imprimable au design soigné (reprenant la
  // charte graphique de l'application) dans un nouvel onglet, puis on
  // déclenche window.print() : l'utilisateur choisit "Enregistrer au format
  // PDF" dans la boîte de dialogue native du navigateur, ce qui fonctionne
  // intégralement hors-ligne sans bibliothèque tierce.
  // ---------------------------------------------------------------------
  var PRINT_CSS =
    '*{box-sizing:border-box;}' +
    'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:#1c2333;margin:0;padding:0;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact;}' +
    '.pr-page{max-width:1000px;margin:0 auto;padding:30px 34px 10px;}' +
    '.pr-header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #3454d1;padding-bottom:16px;margin-bottom:22px;}' +
    '.pr-header-left{display:flex;align-items:center;gap:12px;}' +
    '.pr-logo{width:42px;height:42px;border-radius:10px;background:linear-gradient(135deg,#3454d1,#263c9e);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:15px;flex-shrink:0;}' +
    '.pr-company{font-weight:700;font-size:16px;color:#1c2333;}' +
    '.pr-app{font-size:11.5px;color:#6b7280;margin-top:1px;}' +
    '.pr-header-right{text-align:right;}' +
    '.pr-title{font-size:19px;font-weight:700;color:#263c9e;}' +
    '.pr-subtitle{font-size:12px;color:#6b7280;margin-top:3px;white-space:pre-line;}' +
    '.pr-gendate{font-size:10.5px;color:#9aa1b1;margin-top:8px;}' +
    '.pr-kpis{display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap;}' +
    '.pr-kpi{flex:1;min-width:120px;background:#f9fafc;border:1px solid #e3e7f0;border-radius:10px;padding:11px 13px;}' +
    '.pr-kpi-label{font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:.03em;}' +
    '.pr-kpi-value{font-size:19px;font-weight:700;color:#1c2333;margin-top:2px;}' +
    '.pr-section-title{font-size:12.5px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;color:#263c9e;margin:20px 0 9px;padding-top:4px;}' +
    'table.pr-table{width:100%;border-collapse:collapse;font-size:11.5px;}' +
    'table.pr-table th{background:#3454d1;color:#fff;text-align:left;padding:7px 9px;font-weight:600;}' +
    'table.pr-table td{padding:6px 9px;border-bottom:1px solid #e3e7f0;vertical-align:top;}' +
    'table.pr-table tr:nth-child(even) td{background:#f9fafc;}' +
    'table.pr-table tr{page-break-inside:avoid;}' +
    '.pr-desc{font-size:10px;color:#6b7280;margin-top:2px;font-weight:400;}' +
    '.pr-badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:10px;font-weight:600;white-space:nowrap;}' +
    '.pr-badge-neutral{background:#e3e7f0;color:#1c2333;}' +
    '.pr-badge-primary{background:#e8ecfd;color:#263c9e;}' +
    '.pr-badge-accent{background:#e3faf6;color:#0d8f80;}' +
    '.pr-badge-success{background:#e6f7f1;color:#128a5f;}' +
    '.pr-badge-warning{background:#fdf3e3;color:#a86d0d;}' +
    '.pr-badge-danger{background:#fbe9e9;color:#b83636;}' +
    '.pr-badge-info{background:#e8f2fc;color:#25629f;}' +
    '.pr-empty{padding:18px;text-align:center;color:#9aa1b1;font-size:12.5px;background:#f9fafc;border:1px dashed #ccd3e3;border-radius:10px;}' +
    '.pr-footer{margin-top:26px;padding-top:12px;border-top:1px solid #e3e7f0;font-size:10px;color:#9aa1b1;text-align:center;}' +
    '.pr-pagebreak{page-break-before:always;}' +
    '@page{margin:13mm 12mm;}' +
    '@media print{.pr-page{padding:0;max-width:none;}}';

  function printReport(title, bodyHtml, opts) {
    opts = opts || {};
    var data = (global.DB && global.DB.getData) ? global.DB.getData() : {};
    var entreprise = (data.settings && data.settings.entrepriseName) || "LivraisonManager";
    var now = new Date();
    var genDate = now.toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" }) +
      " à " + now.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    var win = window.open("", "_blank");
    if (!win) {
      toast("Merci d'autoriser les fenêtres pop-up de ce site pour exporter en PDF.", "danger");
      return null;
    }
    var html =
      '<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>' + escapeHtml(title) + '</title>' +
      '<style>' + PRINT_CSS + '</style></head><body>' +
        '<div class="pr-page">' +
          '<header class="pr-header">' +
            '<div class="pr-header-left"><div class="pr-logo">LM</div><div><div class="pr-company">' + escapeHtml(entreprise) + '</div><div class="pr-app">LivraisonManager — Gestion de livraison</div></div></div>' +
            '<div class="pr-header-right"><div class="pr-title">' + escapeHtml(title) + '</div>' +
              (opts.subtitle ? '<div class="pr-subtitle">' + opts.subtitle + '</div>' : '') +
              '<div class="pr-gendate">Généré le ' + genDate + '</div>' +
            '</div>' +
          '</header>' +
          bodyHtml +
          '<footer class="pr-footer">Document généré automatiquement par LivraisonManager — usage interne.</footer>' +
        '</div>' +
        '<script>window.onload = function () { setTimeout(function () { window.print(); }, 250); };<\/script>' +
      '</body></html>';
    win.document.open();
    win.document.write(html);
    win.document.close();
    return win;
  }

  global.LM = {
    ICONS: ICONS,
    icon: icon,
    initShell: initShell,
    toast: toast,
    escapeHtml: escapeHtml,
    openModal: openModal,
    closeModal: closeModal,
    confirmDialog: confirmDialog,
    printReport: printReport
  };
})(typeof window !== "undefined" ? window : globalThis);


/* ==== js/charts.js ==== */
/*!
 * charts.js - Mini librairie de graphiques SVG, sans dépendance externe.
 * Palette catégorielle validée (voir compétence "dataviz") : ordre fixe, jamais recyclé.
 */
(function (global) {
  "use strict";

  var PALETTE = ["#2a78d6", "#1baf7a", "#eda100", "#008300", "#4a3aa7", "#e34948", "#e87ba4", "#eb6834"];
  var INK_SECONDARY = "#6b7280";
  var INK_MUTED = "#9aa1b1";
  var GRID = "#e3e7f0";
  var BASELINE = "#ccd3e3";

  function seriesColor(i) { return PALETTE[i % PALETTE.length]; }

  function el(tag, attrs, parent) {
    var e = document.createElementNS("http://www.w3.org/2000/svg", tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (parent) parent.appendChild(e);
    return e;
  }

  function niceMax(v) {
    if (v <= 0) return 10;
    var pow = Math.pow(10, Math.floor(Math.log10(v)));
    var n = v / pow;
    var step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
    return step * pow;
  }

  function fmtDefault(v) {
    return Math.round(v).toLocaleString("fr-FR");
  }

  function truncateLabel(text, maxChars) {
    text = text || "";
    if (text.length <= maxChars) return text;
    return text.slice(0, Math.max(1, maxChars - 1)) + "…";
  }

  // ------------------------------------------------------------------
  // Tooltip singleton
  // ------------------------------------------------------------------
  var tooltipEl = null;
  function getTooltip() {
    if (!tooltipEl) {
      tooltipEl = document.createElement("div");
      tooltipEl.style.cssText = "position:fixed;pointer-events:none;background:#1c2333;color:#fff;font-size:12px;" +
        "padding:8px 10px;border-radius:8px;box-shadow:0 8px 20px rgba(20,25,45,.25);z-index:500;display:none;" +
        "line-height:1.5;max-width:240px;";
      document.body.appendChild(tooltipEl);
    }
    return tooltipEl;
  }
  function showTooltip(evt, html) {
    var tt = getTooltip();
    tt.innerHTML = html;
    tt.style.display = "block";
    var x = evt.clientX + 14, y = evt.clientY + 14;
    var rect = tt.getBoundingClientRect();
    if (x + rect.width > window.innerWidth - 10) x = evt.clientX - rect.width - 14;
    if (y + rect.height > window.innerHeight - 10) y = evt.clientY - rect.height - 14;
    tt.style.left = x + "px";
    tt.style.top = y + "px";
  }
  function hideTooltip() { if (tooltipEl) tooltipEl.style.display = "none"; }

  function legendHtml(series) {
    if (series.length < 2) return "";
    return '<div class="chart-legend" style="display:flex;flex-wrap:wrap;gap:14px;margin-top:12px;justify-content:center;">' +
      series.map(function (s, i) {
        var color = s.color || seriesColor(i);
        return '<div style="display:flex;align-items:center;gap:6px;font-size:0.78rem;color:' + INK_SECONDARY + ';">' +
          '<span style="width:10px;height:10px;border-radius:3px;background:' + color + ';display:inline-block;"></span>' + LM.escapeHtml(s.name) + '</div>';
      }).join("") + '</div>';
  }

  // ------------------------------------------------------------------
  // Bar chart (mono ou multi-séries groupées)
  // ------------------------------------------------------------------
  function barChart(container, opts) {
    container.innerHTML = "";
    var labels = opts.labels || [];
    var series = opts.series || [];
    var height = opts.height || 280;
    var fmt = opts.yFormat || fmtDefault;
    var w = container.clientWidth || 600;
    var padding = { top: 18, right: 16, bottom: 34, left: 46 };
    var plotW = w - padding.left - padding.right;
    var plotH = height - padding.top - padding.bottom;

    var maxVal = 0;
    series.forEach(function (s) { s.data.forEach(function (v) { if (v > maxVal) maxVal = v; }); });
    var axisMax = niceMax(maxVal || 1);

    var svg = el("svg", { viewBox: "0 0 " + w + " " + height, width: "100%", height: height, style: "overflow:visible;font-family:inherit;" }, container);

    // gridlines + y ticks
    var steps = 4;
    for (var i = 0; i <= steps; i++) {
      var val = (axisMax / steps) * i;
      var y = padding.top + plotH - (val / axisMax) * plotH;
      el("line", { x1: padding.left, x2: w - padding.right, y1: y, y2: y, stroke: GRID, "stroke-width": 1 }, svg);
      var t = el("text", { x: padding.left - 8, y: y + 4, "text-anchor": "end", fill: INK_MUTED, "font-size": 11 }, svg);
      t.textContent = fmt(val);
    }
    el("line", { x1: padding.left, x2: w - padding.right, y1: padding.top + plotH, y2: padding.top + plotH, stroke: BASELINE, "stroke-width": 1 }, svg);

    var groupCount = labels.length;
    var groupW = plotW / groupCount;
    var barGap = 3;
    var barW = Math.min(24, (groupW - barGap * (series.length + 1)) / Math.max(series.length, 1));
    if (barW < 2) barW = 2;

    labels.forEach(function (label, gi) {
      var groupX = padding.left + gi * groupW;
      var totalBarsW = barW * series.length + barGap * (series.length - 1);
      var startX = groupX + (groupW - totalBarsW) / 2;

      series.forEach(function (s, si) {
        var v = s.data[gi] || 0;
        var barH = axisMax > 0 ? (v / axisMax) * plotH : 0;
        var x = startX + si * (barW + barGap);
        var y = padding.top + plotH - barH;
        var color = s.color || seriesColor(si);
        var rect = el("rect", {
          x: x, y: y, width: barW, height: Math.max(barH, 0),
          rx: Math.min(4, barW / 2), ry: Math.min(4, barW / 2),
          fill: color, style: "cursor:pointer;"
        }, svg);
        rect.addEventListener("mousemove", function (evt) {
          showTooltip(evt, "<strong>" + LM.escapeHtml(label) + "</strong><br>" + LM.escapeHtml(s.name) + " : " + fmt(v));
        });
        rect.addEventListener("mouseleave", hideTooltip);
      });

      if (groupCount <= 20 || gi % Math.ceil(groupCount / 20) === 0) {
        var lt = el("text", {
          x: groupX + groupW / 2, y: height - padding.bottom + 18,
          "text-anchor": "middle", fill: INK_MUTED, "font-size": 10.5
        }, svg);
        var maxChars = Math.max(4, Math.floor(groupW / 6.2));
        lt.textContent = truncateLabel(label, maxChars);
        if (label.length > maxChars) {
          var titleEl = document.createElementNS("http://www.w3.org/2000/svg", "title");
          titleEl.textContent = label;
          lt.appendChild(titleEl);
        }
      }
    });

    var legend = document.createElement("div");
    legend.innerHTML = legendHtml(series);
    container.appendChild(legend);
  }

  // ------------------------------------------------------------------
  // Line chart (multi-séries)
  // ------------------------------------------------------------------
  function lineChart(container, opts) {
    container.innerHTML = "";
    var labels = opts.labels || [];
    var series = opts.series || [];
    var height = opts.height || 280;
    var fmt = opts.yFormat || fmtDefault;
    var w = container.clientWidth || 600;
    var padding = { top: 18, right: 20, bottom: 34, left: 46 };
    var plotW = w - padding.left - padding.right;
    var plotH = height - padding.top - padding.bottom;

    var maxVal = 0;
    series.forEach(function (s) { s.data.forEach(function (v) { if (v > maxVal) maxVal = v; }); });
    var axisMax = niceMax(maxVal || 1);

    var svg = el("svg", { viewBox: "0 0 " + w + " " + height, width: "100%", height: height, style: "overflow:visible;font-family:inherit;" }, container);

    var steps = 4;
    for (var i = 0; i <= steps; i++) {
      var val = (axisMax / steps) * i;
      var y = padding.top + plotH - (val / axisMax) * plotH;
      el("line", { x1: padding.left, x2: w - padding.right, y1: y, y2: y, stroke: GRID, "stroke-width": 1 }, svg);
      var t = el("text", { x: padding.left - 8, y: y + 4, "text-anchor": "end", fill: INK_MUTED, "font-size": 11 }, svg);
      t.textContent = fmt(val);
    }
    el("line", { x1: padding.left, x2: w - padding.right, y1: padding.top + plotH, y2: padding.top + plotH, stroke: BASELINE, "stroke-width": 1 }, svg);

    var n = labels.length;
    function xAt(i) { return n <= 1 ? padding.left + plotW / 2 : padding.left + (i / (n - 1)) * plotW; }
    function yAt(v) { return padding.top + plotH - (axisMax > 0 ? (v / axisMax) * plotH : 0); }

    var maxTicks = Math.max(3, Math.floor(plotW / 46));
    var tickEvery = Math.max(1, Math.ceil(n / maxTicks));
    labels.forEach(function (label, i) {
      if (i % tickEvery === 0 || i === n - 1) {
        var lt = el("text", { x: xAt(i), y: height - padding.bottom + 18, "text-anchor": "middle", fill: INK_MUTED, "font-size": 10.5 }, svg);
        lt.textContent = label;
      }
    });

    series.forEach(function (s, si) {
      var color = s.color || seriesColor(si);
      var pts = s.data.map(function (v, i) { return xAt(i) + "," + yAt(v); }).join(" ");

      // aire (wash ~10%)
      if (opts.area !== false) {
        var areaPts = pts + " " + xAt(n - 1) + "," + yAt(0) + " " + xAt(0) + "," + yAt(0);
        el("polygon", { points: areaPts, fill: color, opacity: 0.10 }, svg);
      }

      el("polyline", { points: pts, fill: "none", stroke: color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);

      s.data.forEach(function (v, i) {
        var cx = xAt(i), cy = yAt(v);
        el("circle", { cx: cx, cy: cy, r: 5, fill: "#fff", stroke: color, "stroke-width": 2 }, svg);
        var hit = el("circle", { cx: cx, cy: cy, r: 9, fill: "transparent", style: "cursor:pointer;" }, svg);
        hit.addEventListener("mousemove", function (evt) {
          showTooltip(evt, "<strong>" + LM.escapeHtml(labels[i]) + "</strong><br>" + LM.escapeHtml(s.name) + " : " + fmt(v));
        });
        hit.addEventListener("mouseleave", hideTooltip);
      });
    });

    var legend = document.createElement("div");
    legend.innerHTML = legendHtml(series);
    container.appendChild(legend);
  }

  // ------------------------------------------------------------------
  // Donut chart
  // ------------------------------------------------------------------
  function donutChart(container, opts) {
    container.innerHTML = "";
    var data = (opts.data || []).filter(function (d) { return d.value > 0; });
    var height = opts.height || 240;
    var fmt = opts.valueFormat || fmtDefault;
    var w = container.clientWidth || 300;
    var size = Math.min(w, height);
    var cx = size / 2, cy = size / 2;
    var rOuter = size / 2 - 6;
    var rInner = rOuter * 0.6;

    var total = data.reduce(function (a, d) { return a + d.value; }, 0);

    var wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;gap:22px;align-items:center;flex-wrap:wrap;justify-content:center;";
    container.appendChild(wrap);

    var svg = el("svg", { viewBox: "0 0 " + size + " " + size, width: size, height: size }, wrap);

    if (total === 0) {
      el("circle", { cx: cx, cy: cy, r: rOuter, fill: "none", stroke: GRID, "stroke-width": rOuter - rInner }, svg);
    } else {
      var angle = -Math.PI / 2;
      var gapAngle = 0.014; // ~2px de séparation visuelle entre parts
      data.forEach(function (d, i) {
        var frac = d.value / total;
        var sweep = frac * (Math.PI * 2) - gapAngle;
        if (sweep < 0) sweep = 0;
        var a0 = angle, a1 = angle + sweep;
        var color = d.color || seriesColor(i);
        var path = donutSlicePath(cx, cy, rInner, rOuter, a0, a1);
        var p = el("path", { d: path, fill: color, style: "cursor:pointer;" }, svg);
        p.addEventListener("mousemove", function (evt) {
          showTooltip(evt, "<strong>" + LM.escapeHtml(d.label) + "</strong><br>" + fmt(d.value) + " (" + Math.round(frac * 100) + "%)");
        });
        p.addEventListener("mouseleave", hideTooltip);
        angle += frac * (Math.PI * 2);
      });
    }

    var centerWrap = document.createElement("div");
    centerWrap.style.cssText = "position:relative;";
    var centerText = document.createElement("div");
    centerText.style.cssText = "position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);text-align:center;pointer-events:none;";
    centerText.innerHTML = '<div style="font-size:1.3rem;font-weight:700;">' + fmt(total) + '</div><div style="font-size:0.7rem;color:' + INK_MUTED + ';">total</div>';
    svg.parentNode.style.position = "relative";
    svg.parentNode.insertBefore(centerText, svg.nextSibling);

    var legend = document.createElement("div");
    legend.style.cssText = "display:flex;flex-direction:column;gap:8px;";
    legend.innerHTML = data.map(function (d, i) {
      var color = d.color || seriesColor(i);
      var pct = total ? Math.round((d.value / total) * 100) : 0;
      return '<div style="display:flex;align-items:center;gap:8px;font-size:0.8rem;">' +
        '<span style="width:10px;height:10px;border-radius:3px;background:' + color + ';display:inline-block;flex-shrink:0;"></span>' +
        '<span style="flex:1;color:' + INK_SECONDARY + ';">' + LM.escapeHtml(d.label) + '</span>' +
        '<strong>' + fmt(d.value) + '</strong>' +
        '<span style="color:' + INK_MUTED + ';font-size:0.72rem;">' + pct + '%</span></div>';
    }).join("");
    wrap.appendChild(legend);
  }

  function donutSlicePath(cx, cy, rInner, rOuter, a0, a1) {
    var x0o = cx + rOuter * Math.cos(a0), y0o = cy + rOuter * Math.sin(a0);
    var x1o = cx + rOuter * Math.cos(a1), y1o = cy + rOuter * Math.sin(a1);
    var x0i = cx + rInner * Math.cos(a1), y0i = cy + rInner * Math.sin(a1);
    var x1i = cx + rInner * Math.cos(a0), y1i = cy + rInner * Math.sin(a0);
    var large = (a1 - a0) > Math.PI ? 1 : 0;
    return [
      "M", x0o, y0o,
      "A", rOuter, rOuter, 0, large, 1, x1o, y1o,
      "L", x0i, y0i,
      "A", rInner, rInner, 0, large, 0, x1i, y1i,
      "Z"
    ].join(" ");
  }

  global.LMCharts = {
    PALETTE: PALETTE,
    seriesColor: seriesColor,
    barChart: barChart,
    lineChart: lineChart,
    donutChart: donutChart
  };
})(typeof window !== "undefined" ? window : globalThis);


/* ==== js/vendor/xlsx-lite.js ==== */
/*!
 * xlsx-lite.js
 * Lecteur .xlsx minimal, 100% autonome (sans dépendance réseau), pour navigateur.
 * Implémente : lecture d'archive ZIP (stocké + Deflate/RFC1951) + parsing XML natif (DOMParser)
 * afin d'extraire la première feuille d'un classeur Excel (.xlsx) sous forme de tableau de lignes.
 *
 * Portée volontairement réduite à l'usage de cette application :
 *  - lit la première feuille du classeur (dans l'ordre déclaré par workbook.xml)
 *  - gère les cellules texte (chaînes partagées / inline / formule), numériques et booléennes
 *  - ne gère pas les feuilles protégées/chiffrées, ni les formats numériques avancés
 *
 * L'algorithme d'inflate est un portage JS de l'algorithme de référence "puff" (domaine public,
 * Mark Adler / zlib), adapté pour ne décompresser que des flux "raw deflate" (sans en-tête zlib/gzip),
 * ce qui correspond au format utilisé à l'intérieur des archives ZIP.
 */
(function (global) {
  "use strict";

  // ---------------------------------------------------------------------
  // 1) INFLATE (RFC 1951) - décompression "raw deflate"
  // ---------------------------------------------------------------------

  var MAXBITS = 15;
  var MAXLCODES = 286;
  var MAXDCODES = 30;
  var MAXCODES = MAXLCODES + MAXDCODES;
  var FIXLCODES = 288;

  var LENS = [ // Table des longueurs (RFC1951 §3.2.5)
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
    35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258
  ];
  var LEXT = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
    3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0
  ];
  var DISTS = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
    257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
    8193, 12289, 16385, 24577
  ];
  var DEXT = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
    7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13
  ];

  function BitStream(data) {
    this.data = data;
    this.bytePos = 0;
    this.bitBuf = 0;
    this.bitCnt = 0;
  }
  BitStream.prototype.bits = function (need) {
    var val = this.bitBuf;
    while (this.bitCnt < need) {
      if (this.bytePos >= this.data.length) {
        throw new Error("xlsx-lite: fin de flux inattendue (inflate)");
      }
      val |= this.data[this.bytePos++] << this.bitCnt;
      this.bitCnt += 8;
    }
    this.bitBuf = val >>> need;
    this.bitCnt -= need;
    return val & ((1 << need) - 1);
  };
  BitStream.prototype.alignByte = function () {
    this.bitBuf = 0;
    this.bitCnt = 0;
  };

  function Huffman() {
    this.count = new Array(MAXBITS + 1).fill(0);
    this.symbol = new Array(MAXCODES).fill(0);
  }

  // construit une table de Huffman canonique à partir des longueurs de code
  function construct(h, lengths, n) {
    var i, len;
    for (len = 0; len <= MAXBITS; len++) h.count[len] = 0;
    for (i = 0; i < n; i++) h.count[lengths[i]]++;
    if (h.count[0] === n) return 0; // aucun code utilisé

    var offs = new Array(MAXBITS + 2).fill(0);
    for (len = 1; len < MAXBITS; len++) offs[len + 1] = offs[len] + h.count[len];

    for (i = 0; i < n; i++) {
      if (lengths[i] !== 0) {
        h.symbol[offs[lengths[i]]++] = i;
      }
    }
    return 0;
  }

  // décode un symbole depuis le flux de bits en utilisant la table de Huffman h
  function decodeSym(strm, h) {
    var code = 0, first = 0, index = 0;
    for (var len = 1; len <= MAXBITS; len++) {
      code |= strm.bits(1);
      var count = h.count[len];
      if (code - count < first) {
        return h.symbol[index + (code - first)];
      }
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw new Error("xlsx-lite: code Huffman invalide");
  }

  function codes(strm, out, lencode, distcode) {
    do {
      var sym = decodeSym(strm, lencode);
      if (sym < 256) {
        out.push(sym);
      } else if (sym === 256) {
        break; // fin de bloc
      } else {
        sym -= 257;
        if (sym >= LENS.length) throw new Error("xlsx-lite: longueur invalide");
        var len = LENS[sym] + strm.bits(LEXT[sym]);
        var symDist = decodeSym(strm, distcode);
        var dist = DISTS[symDist] + strm.bits(DEXT[symDist]);
        var start = out.length - dist;
        for (var k = 0; k < len; k++) out.push(out[start + k]);
      }
    } while (true);
  }

  var FIXED_LCODE = null, FIXED_DCODE = null;
  function buildFixed() {
    if (FIXED_LCODE) return;
    var lengths = new Array(FIXLCODES).fill(0);
    var i = 0;
    for (; i < 144; i++) lengths[i] = 8;
    for (; i < 256; i++) lengths[i] = 9;
    for (; i < 280; i++) lengths[i] = 7;
    for (; i < FIXLCODES; i++) lengths[i] = 8;
    FIXED_LCODE = new Huffman();
    construct(FIXED_LCODE, lengths, FIXLCODES);

    var dlengths = new Array(MAXDCODES).fill(5);
    FIXED_DCODE = new Huffman();
    construct(FIXED_DCODE, dlengths, MAXDCODES);
  }

  function dynamicBlock(strm, out) {
    var order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
    var nlen = strm.bits(5) + 257;
    var ndist = strm.bits(5) + 1;
    var ncode = strm.bits(4) + 4;

    var lengths = new Array(MAXCODES).fill(0);
    var i;
    for (i = 0; i < ncode; i++) lengths[order[i]] = strm.bits(3);
    for (; i < 19; i++) lengths[order[i]] = 0;

    var lencodeLen = new Huffman();
    construct(lencodeLen, lengths, 19);

    var lenLengths = new Array(nlen + ndist).fill(0);
    i = 0;
    while (i < nlen + ndist) {
      var sym = decodeSym(strm, lencodeLen);
      if (sym < 16) {
        lenLengths[i++] = sym;
      } else if (sym === 16) {
        var prev = lenLengths[i - 1];
        var rep = strm.bits(2) + 3;
        while (rep--) { lenLengths[i++] = prev; }
      } else if (sym === 17) {
        var rep2 = strm.bits(3) + 3;
        while (rep2--) { lenLengths[i++] = 0; }
      } else {
        var rep3 = strm.bits(7) + 11;
        while (rep3--) { lenLengths[i++] = 0; }
      }
    }

    var lencode = new Huffman();
    construct(lencode, lenLengths.slice(0, nlen), nlen);
    var distcode = new Huffman();
    construct(distcode, lenLengths.slice(nlen), ndist);

    codes(strm, out, lencode, distcode);
  }

  function storedBlock(strm, out) {
    strm.alignByte();
    var d = strm.data;
    var len = d[strm.bytePos] | (d[strm.bytePos + 1] << 8);
    strm.bytePos += 4; // len + ~len (nlen), on ignore la vérification
    for (var i = 0; i < len; i++) out.push(d[strm.bytePos++]);
  }

  // Décompresse un flux "raw deflate" (Uint8Array) et renvoie un Uint8Array
  function inflateRaw(data) {
    buildFixed();
    var strm = new BitStream(data);
    var out = [];
    var final;
    do {
      final = strm.bits(1);
      var type = strm.bits(2);
      if (type === 0) {
        storedBlock(strm, out);
      } else if (type === 1) {
        codes(strm, out, FIXED_LCODE, FIXED_DCODE);
      } else if (type === 2) {
        dynamicBlock(strm, out);
      } else {
        throw new Error("xlsx-lite: type de bloc deflate invalide");
      }
    } while (!final);
    return new Uint8Array(out);
  }

  // ---------------------------------------------------------------------
  // 2) Lecteur d'archive ZIP minimal (entrées stockées ou deflate)
  // ---------------------------------------------------------------------

  function readUint32LE(dv, off) { return dv.getUint32(off, true); }
  function readUint16LE(dv, off) { return dv.getUint16(off, true); }

  function parseZip(buffer) {
    var bytes = new Uint8Array(buffer);
    var dv = new DataView(buffer);
    var len = bytes.length;

    // Recherche de l'End Of Central Directory (signature 0x06054b50) en partant de la fin
    var eocdSig = 0x06054b50;
    var eocdOffset = -1;
    var maxBack = Math.min(len, 65557);
    for (var i = len - 22; i >= len - maxBack && i >= 0; i--) {
      if (readUint32LE(dv, i) === eocdSig) { eocdOffset = i; break; }
    }
    if (eocdOffset < 0) throw new Error("xlsx-lite: fichier .xlsx invalide (EOCD introuvable)");

    var entryCount = readUint16LE(dv, eocdOffset + 10);
    var cdOffset = readUint32LE(dv, eocdOffset + 16);

    var entries = {};
    var pos = cdOffset;
    var cdSig = 0x02014b50;
    for (var e = 0; e < entryCount; e++) {
      if (readUint32LE(dv, pos) !== cdSig) break;
      var method = readUint16LE(dv, pos + 10);
      var compSize = readUint32LE(dv, pos + 20);
      var uncompSize = readUint32LE(dv, pos + 24);
      var nameLen = readUint16LE(dv, pos + 28);
      var extraLen = readUint16LE(dv, pos + 30);
      var commentLen = readUint16LE(dv, pos + 32);
      var localHeaderOffset = readUint32LE(dv, pos + 42);
      var nameBytes = bytes.subarray(pos + 46, pos + 46 + nameLen);
      var name = new TextDecoder("utf-8").decode(nameBytes);
      entries[name] = {
        method: method,
        compSize: compSize,
        uncompSize: uncompSize,
        localHeaderOffset: localHeaderOffset
      };
      pos += 46 + nameLen + extraLen + commentLen;
    }

    function getFile(name) {
      var entry = entries[name];
      if (!entry) return null;
      var lp = entry.localHeaderOffset;
      var lSig = readUint32LE(dv, lp);
      if (lSig !== 0x04034b50) throw new Error("xlsx-lite: en-tête local invalide pour " + name);
      var lNameLen = readUint16LE(dv, lp + 26);
      var lExtraLen = readUint16LE(dv, lp + 28);
      var dataStart = lp + 30 + lNameLen + lExtraLen;
      var compData = bytes.subarray(dataStart, dataStart + entry.compSize);
      var raw;
      if (entry.method === 0) {
        raw = compData;
      } else if (entry.method === 8) {
        raw = inflateRaw(compData);
      } else {
        throw new Error("xlsx-lite: méthode de compression non supportée (" + entry.method + ") pour " + name);
      }
      return raw;
    }

    function getText(name) {
      var raw = getFile(name);
      if (!raw) return null;
      return new TextDecoder("utf-8").decode(raw);
    }

    return { entries: entries, getFile: getFile, getText: getText };
  }

  // ---------------------------------------------------------------------
  // 3) Parsing du classeur XLSX -> tableau de lignes
  // ---------------------------------------------------------------------

  function colLetterToIndex(ref) {
    // ref type "A1", "AB12" -> renvoie l'index de colonne (0-based)
    var m = /^([A-Z]+)/.exec(ref);
    if (!m) return 0;
    var letters = m[1];
    var idx = 0;
    for (var i = 0; i < letters.length; i++) {
      idx = idx * 26 + (letters.charCodeAt(i) - 64);
    }
    return idx - 1;
  }

  function parseSharedStrings(xmlText) {
    if (!xmlText) return [];
    var dom = new DOMParser().parseFromString(xmlText, "application/xml");
    var siNodes = dom.getElementsByTagName("si");
    var result = [];
    for (var i = 0; i < siNodes.length; i++) {
      var tNodes = siNodes[i].getElementsByTagName("t");
      var text = "";
      if (tNodes.length) {
        for (var j = 0; j < tNodes.length; j++) text += tNodes[j].textContent;
      }
      result.push(text);
    }
    return result;
  }

  function firstSheetTarget(zip) {
    var wbXml = zip.getText("xl/workbook.xml");
    var relsXml = zip.getText("xl/_rels/workbook.xml.rels");
    if (!wbXml) throw new Error("xlsx-lite: workbook.xml introuvable");

    var dom = new DOMParser().parseFromString(wbXml, "application/xml");
    var sheetNodes = dom.getElementsByTagName("sheet");
    if (!sheetNodes.length) throw new Error("xlsx-lite: aucune feuille trouvée");
    var firstSheet = sheetNodes[0];
    var rId = firstSheet.getAttribute("r:id") || firstSheet.getAttribute("relId");
    var sheetName = firstSheet.getAttribute("name") || "Feuille1";

    var target = null;
    if (relsXml) {
      var relsDom = new DOMParser().parseFromString(relsXml, "application/xml");
      var relNodes = relsDom.getElementsByTagName("Relationship");
      for (var i = 0; i < relNodes.length; i++) {
        if (relNodes[i].getAttribute("Id") === rId) {
          target = relNodes[i].getAttribute("Target");
          break;
        }
      }
    }
    if (!target) target = "worksheets/sheet1.xml";
    target = target.replace(/^\/?/, "").replace(/^xl\//, "");
    return { path: "xl/" + target, name: sheetName };
  }

  function parseSheetXml(xmlText, sharedStrings) {
    var dom = new DOMParser().parseFromString(xmlText, "application/xml");
    var rowNodes = dom.getElementsByTagName("row");
    var rows = [];
    for (var r = 0; r < rowNodes.length; r++) {
      var rowNode = rowNodes[r];
      var cellNodes = rowNode.getElementsByTagName("c");
      var rowArr = [];
      for (var c = 0; c < cellNodes.length; c++) {
        var cellNode = cellNodes[c];
        var ref = cellNode.getAttribute("r") || "";
        var colIdx = ref ? colLetterToIndex(ref) : c;
        var type = cellNode.getAttribute("t");
        var value = null;

        if (type === "inlineStr") {
          var isNode = cellNode.getElementsByTagName("is")[0];
          var tNode = isNode ? isNode.getElementsByTagName("t")[0] : null;
          value = tNode ? tNode.textContent : "";
        } else {
          var vNode = cellNode.getElementsByTagName("v")[0];
          var raw = vNode ? vNode.textContent : "";
          if (type === "s") {
            var idx = parseInt(raw, 10);
            value = sharedStrings[idx] !== undefined ? sharedStrings[idx] : "";
          } else if (type === "str") {
            value = raw;
          } else if (type === "b") {
            value = raw === "1";
          } else if (raw === "") {
            value = null;
          } else {
            var num = parseFloat(raw);
            value = isNaN(num) ? raw : num;
          }
        }
        while (rowArr.length < colIdx) rowArr.push(null);
        rowArr[colIdx] = value;
      }
      rows.push(rowArr);
    }
    return rows;
  }

  // Conversion d'un numéro de série Excel (date) en objet Date JS (UTC).
  // Base = 30/12/1899 : formule standard, correcte pour toutes les dates modernes
  // (le bug historique "1900 bissextile" d'Excel n'affecte que janvier/février 1900).
  function excelSerialToDate(serial) {
    var days = Math.floor(serial);
    var fraction = serial - days;
    var ms = Date.UTC(1899, 11, 30) + days * 86400000 + Math.round(fraction * 86400000);
    return new Date(ms);
  }

  function parseWorkbook(arrayBuffer) {
    var zip = parseZip(arrayBuffer);
    var sharedStrings = parseSharedStrings(zip.getText("xl/sharedStrings.xml"));
    var sheetInfo = firstSheetTarget(zip);
    var sheetXml = zip.getText(sheetInfo.path);
    if (!sheetXml) {
      // repli : essaye worksheets/sheet1.xml directement
      sheetXml = zip.getText("xl/worksheets/sheet1.xml");
    }
    if (!sheetXml) throw new Error("xlsx-lite: feuille introuvable dans le classeur");
    var rows = parseSheetXml(sheetXml, sharedStrings);
    return { sheetName: sheetInfo.name, rows: rows };
  }

  global.XLSXLite = {
    parseWorkbook: parseWorkbook,
    excelSerialToDate: excelSerialToDate,
    _internal: { inflateRaw: inflateRaw, parseZip: parseZip }
  };
})(typeof window !== "undefined" ? window : globalThis);


/* ==== js/app-core.js ==== */
/*!
 * app-core.js - Mini routeur pour l'application une-page (SPA) LivraisonManager.
 * Chaque "page" s'enregistre via App.registerPage(clé, {title, subtitle, render}) ;
 * la navigation se fait par ancre (#/entrepots, #/livreurs, ...) sans rechargement.
 */
(function (global) {
  "use strict";

  var pages = {};
  var firstRun = false;

  function registerPage(key, def) {
    pages[key] = def;
  }

  function currentKey() {
    var hash = (global.location.hash || "").replace(/^#\/?/, "").split("?")[0];
    return pages[hash] ? hash : "dashboard";
  }

  function router() {
    var key = currentKey();
    var def = pages[key];
    if (!def) return; // page pas encore enregistrée (ne devrait pas arriver)
    var content = global.LM.initShell({ active: key, title: def.title, subtitle: def.subtitle });
    def.render(content);
    global.scrollTo(0, 0);
  }

  function isFirstRun() { return firstRun; }

  function start() {
    firstRun = global.DB.seedIfEmpty();
    router();
    global.addEventListener("hashchange", router);
  }

  global.App = {
    registerPage: registerPage,
    isFirstRun: isFirstRun,
    start: start,
    // Permet à une page d'en avertir une autre qu'un ticket de réparation doit être ouvert
    // dès son affichage (ex : bouton "Créer un ticket" depuis la fiche d'un véhicule).
    // La page cible lit puis efface immédiatement cette valeur pour ne pas la ré-ouvrir
    // à chaque nouveau rendu.
    pendingTicketRequest: null,
    // Idem pour le Planning : date (iso) sur laquelle ouvrir la grille (ex : depuis le contrôle des
    // imports de la page Analyse). Lue puis effacée par la page Planning.
    pendingPlanningFocus: null
  };

  document.addEventListener("DOMContentLoaded", start);
})(typeof window !== "undefined" ? window : globalThis);


/* ==== js/dashboard.js ==== */
/*! dashboard.js - Tableau de bord d'accueil */
(function () {
  "use strict";

  App.registerPage("dashboard", {
    title: "Tableau de bord",
    subtitle: "Vue d'ensemble de l'activité",
    render: function (content) { render(content, App.isFirstRun()); }
  });

  var QUICK_LINKS = [
    { href: "#/entrepots", icon: "entrepot", title: "Entrepôts", desc: "Sites logistiques, capacités et responsables" },
    { href: "#/livreurs", icon: "livreur", title: "Livreurs", desc: "Équipe, affectations et statuts" },
    { href: "#/planning", icon: "calendar", title: "Planning", desc: "Planning hebdomadaire, absences et demandes" },
    { href: "#/performance", icon: "trend", title: "Performance livreurs", desc: "Fiche d'activité, primes et matériel par livreur" },
    { href: "#/materiel", icon: "materiel", title: "Matériel", desc: "Véhicules, bacs et équipements" },
    { href: "#/reparations", icon: "wrench", title: "Réparations", desc: "Tickets de réparation et suivi des pannes" },
    { href: "#/analyse", icon: "analyse", title: "Analyse", desc: "Statistiques et import de données Excel" },
    { href: "#/retards", icon: "retard", title: "Retards", desc: "Suivi des retards de livraison et clients concernés" },
    { href: "#/clients", icon: "clients", title: "Clients", desc: "Annuaire des clients livrés et analyse de la liste" },
    { href: "#/zones", icon: "zones", title: "Zones géographiques", desc: "Carte et rayons de couverture" },
    { href: "#/primes", icon: "primes", title: "Primes", desc: "Barème et calcul par livreur" },
    { href: "#/annexes", icon: "tag", title: "Annexes", desc: "Listes de référence personnalisables" },
    { href: "#/historique", icon: "historique", title: "Historique", desc: "Journal des actions effectuées dans l'application" }
  ];

  function render(content, firstRun) {
    var entrepots = DB.list("entrepots");
    var livreurs = DB.list("livreurs");
    var vehicules = DB.list("vehicules");

    var end = new Date(); var start = new Date(); start.setDate(end.getDate() - 29);
    var startIso = start.toISOString().slice(0, 10), endIso = end.toISOString().slice(0, 10);
    var rows = DB.list("livraisons").filter(function (r) { return r.date >= startIso && r.date <= endIso; });
    var nbLivraisons = rows.reduce(function (a, r) { return a + (Number(r.nbLivraisons) || 0); }, 0);
    var nbBacs = rows.reduce(function (a, r) { return a + (Number(r.nbBacs) || 0); }, 0);
    var actifs = livreurs.filter(function (l) { return l.statut === "actif"; }).length;

    var soon = new Date(); soon.setDate(soon.getDate() + 14);
    var alerts = [];
    vehicules.forEach(function (v) {
      if (v.statut === "hors_service") alerts.push({ type: "danger", text: "Véhicule " + v.plaque + " hors service." });
      else if (v.statut === "maintenance") alerts.push({ type: "warning", text: "Véhicule " + v.plaque + " en maintenance." });
      else if (v.prochainEntretien && new Date(v.prochainEntretien) <= soon) alerts.push({ type: "warning", text: "Entretien de " + v.plaque + " prévu le " + DB.fmtDate(v.prochainEntretien) + "." });
    });
    livreurs.forEach(function (l) {
      if (l.statut === "arret") alerts.push({ type: "warning", text: DB.livreurNomComplet(l) + " est en arrêt / indisponible." });
    });
    DB.list("materiels").forEach(function (m) {
      if (m.etat === "a_remplacer") alerts.push({ type: "danger", text: LM.escapeHtml(m.nom) + " à remplacer (" + DB.fmtNum(m.quantite) + " unités)." });
    });
    DB.list("ticketsReparation").forEach(function (t) {
      if (t.statut !== "nouveau" && t.statut !== "en_cours") return;
      var label = DB.materielLabel(t.materielType, t.materielId) || t.materielLabel || "Élément supprimé";
      if (t.immobilise) alerts.push({ type: "danger", text: "Ticket immobilisant sur " + LM.escapeHtml(label) + " — " + LM.escapeHtml(t.titre) + "." });
      else if (t.priorite === "urgente") alerts.push({ type: "warning", text: "Ticket urgent sur " + LM.escapeHtml(label) + " — " + LM.escapeHtml(t.titre) + "." });
    });

    content.innerHTML =
      (firstRun ? '<div class="card" style="border-left:4px solid var(--color-primary);"><h3>Bienvenue dans LivraisonManager</h3><p>Des données de démonstration ont été générées pour vous permettre d\'explorer l\'application (entrepôts, livreurs, véhicules et 75 jours d\'historique de livraisons). Vous pouvez les modifier ou les supprimer à tout moment.</p></div>' : "") +
      '<div class="grid grid-4" style="margin-bottom:22px;">' +
        kpi("truck", "Livraisons (30 derniers jours)", DB.fmtNum(nbLivraisons)) +
        kpi("box", "Bacs livrés (30 derniers jours)", DB.fmtNum(nbBacs)) +
        kpi("entrepot", "Entrepôts", DB.fmtNum(entrepots.length)) +
        kpi("livreur", "Livreurs actifs", DB.fmtNum(actifs) + " / " + DB.fmtNum(livreurs.length)) +
      '</div>' +
      '<div class="grid" style="grid-template-columns: 1.4fr 1fr; gap:20px; align-items:start;">' +
        '<div class="card"><h2>Livraisons — 14 derniers jours</h2><div id="chartMini" style="margin-top:10px;"></div></div>' +
        '<div class="card"><h2>Alertes</h2>' +
          (alerts.length ? alerts.slice(0, 8).map(function (a) {
            return '<div class="flex gap-8" style="align-items:center;padding:8px 0;border-bottom:1px solid var(--color-border);"><span class="badge badge-' + a.type + '"> </span><span class="text-sm">' + a.text + '</span></div>';
          }).join("") : '<p class="text-sm text-faint">Aucune alerte pour le moment.</p>') +
        '</div>' +
      '</div>' +
      '<h2 style="margin:26px 0 14px;">Accès rapide</h2>' +
      '<div class="grid grid-3">' +
        QUICK_LINKS.map(function (l) {
          return '<a class="card" href="' + l.href + '" style="display:block;text-decoration:none;color:inherit;">' +
            '<div class="kpi-icon" style="margin-bottom:10px;">' + LM.icon(l.icon) + '</div>' +
            '<h3 style="margin-bottom:4px;">' + l.title + '</h3><p class="text-sm mb-0">' + l.desc + '</p>' +
          '</a>';
        }).join("") +
      '</div>';

    var d0 = new Date(); d0.setDate(d0.getDate() - 13);
    var days = []; for (var d = new Date(d0); d <= new Date(); d.setDate(d.getDate() + 1)) days.push(d.toISOString().slice(0, 10));
    var byDay = {};
    DB.list("livraisons").forEach(function (r) { byDay[r.date] = (byDay[r.date] || 0) + (Number(r.nbLivraisons) || 0); });
    LMCharts.lineChart(document.getElementById("chartMini"), {
      labels: days.map(function (iso) { return iso.slice(8, 10) + "/" + iso.slice(5, 7); }),
      series: [{ name: "Livraisons", data: days.map(function (iso) { return byDay[iso] || 0; }) }],
      height: 240
    });
  }

  function kpi(iconName, label, value) {
    return '<div class="kpi"><div class="kpi-label"><span class="kpi-icon">' + LM.icon(iconName) + '</span>' + label + '</div><div class="kpi-value">' + value + '</div></div>';
  }
})();


/* ==== js/entrepots.js ==== */
/*! entrepots.js - Page de gestion des entrepôts */
(function () {
  "use strict";

  App.registerPage("entrepots", { title: "Entrepôts", subtitle: "Sites logistiques et zones de couverture", render: render });

  function render(content) {
    var entrepots = DB.list("entrepots");
    var livreurs = DB.list("livreurs");
    var vehicules = DB.list("vehicules");

    var totalCapacite = entrepots.reduce(function (a, e) { return a + (Number(e.capacite) || 0); }, 0);

    content.innerHTML =
      '<div class="grid grid-4" style="margin-bottom:22px;">' +
        kpi("entrepot", "Entrepôts", DB.fmtNum(entrepots.length)) +
        kpi("box", "Capacité totale (bacs)", DB.fmtNum(totalCapacite)) +
        kpi("livreur", "Livreurs rattachés", DB.fmtNum(livreurs.length)) +
        kpi("truck", "Véhicules rattachés", DB.fmtNum(vehicules.length)) +
      '</div>' +
      '<div class="card">' +
        '<div class="card-header"><div><h2>Liste des entrepôts</h2><p>Gérez vos sites, leurs responsables et leur capacité.</p></div>' +
        '<button class="btn btn-primary" id="btnAdd">' + LM.icon("plus") + ' Ajouter un entrepôt</button></div>' +
        '<div class="table-wrap"><table><thead><tr>' +
          '<th>Entrepôt</th><th>Ville</th><th>Responsable</th><th>Contact</th>' +
          '<th class="num">Capacité</th><th class="num">Rayon</th><th class="num">Livreurs</th><th class="num">Véhicules</th><th></th>' +
        '</tr></thead><tbody id="tbody"></tbody></table></div>' +
      '</div>';

    document.getElementById("btnAdd").addEventListener("click", function () { openForm(null); });
    renderRows();

    function renderRows() {
      var tbody = document.getElementById("tbody");
      var rows = DB.list("entrepots");
      if (!rows.length) {
        tbody.innerHTML = '<tr class="empty-row"><td colspan="9">Aucun entrepôt pour le moment.</td></tr>';
        return;
      }
      tbody.innerHTML = rows.map(function (e) {
        var nbLivreurs = DB.list("livreurs").filter(function (l) { return DB.livreurAEntrepot(l, e.id); }).length;
        var nbVehicules = DB.list("vehicules").filter(function (v) { return v.entrepotId === e.id; }).length;
        var tagsHtml = (Array.isArray(e.tags) && e.tags.length) ?
          '<div class="text-faint text-sm" title="Anciens noms associés"><span class="icon-inline">' + LM.icon("tag") + '</span>' + e.tags.map(function (t) { return LM.escapeHtml(t); }).join(", ") + '</div>' : "";
        return '<tr>' +
          '<td><strong>' + LM.escapeHtml(e.nom) + '</strong><div class="text-faint text-sm">' + LM.escapeHtml(e.adresse || "") + '</div>' + tagsHtml + '</td>' +
          '<td>' + LM.escapeHtml(e.ville || "") + (e.codePostal ? ' (' + LM.escapeHtml(e.codePostal) + ')' : '') + '</td>' +
          '<td>' + LM.escapeHtml(e.responsable || "—") + '</td>' +
          '<td class="text-sm">' + LM.escapeHtml(e.telephone || "") + '<br><span class="text-faint">' + LM.escapeHtml(e.email || "") + '</span></td>' +
          '<td class="num">' + DB.fmtNum(e.capacite) + '</td>' +
          '<td class="num">' + (e.rayonKm ? e.rayonKm + " km" : "—") + '</td>' +
          '<td class="num">' + nbLivreurs + '</td>' +
          '<td class="num">' + nbVehicules + '</td>' +
          '<td class="actions">' +
            '<button class="btn btn-ghost btn-sm btn-icon" data-edit="' + e.id + '" title="Modifier">' + LM.icon("edit") + '</button>' +
            '<button class="btn btn-ghost btn-sm btn-icon" data-del="' + e.id + '" title="Supprimer">' + LM.icon("trash") + '</button>' +
          '</td></tr>';
      }).join("");

      tbody.querySelectorAll("[data-edit]").forEach(function (btn) {
        btn.addEventListener("click", function () { openForm(DB.get("entrepots", btn.getAttribute("data-edit"))); });
      });
      tbody.querySelectorAll("[data-del]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var id = btn.getAttribute("data-del");
          var e = DB.get("entrepots", id);
          var nbLivreurs = DB.list("livreurs").filter(function (l) { return DB.livreurAEntrepot(l, id); }).length;
          var nbVehicules = DB.list("vehicules").filter(function (v) { return v.entrepotId === id; }).length;
          var warn = (nbLivreurs || nbVehicules) ?
            " " + nbLivreurs + " livreur(s) et " + nbVehicules + " véhicule(s) resteront sans entrepôt rattaché." : "";
          LM.confirmDialog("Supprimer l'entrepôt <strong>" + LM.escapeHtml(e.nom) + "</strong> ?" + warn, function () {
            DB.remove("entrepots", id);
            DB.logHistorique("Entrepôts", "suppression", "Suppression entrepôt : " + e.nom);
            LM.toast("Entrepôt supprimé.", "success");
            renderRows();
            refreshKpis();
          });
        });
      });
    }

    function refreshKpis() {
      render(content);
    }

    function openForm(existing) {
      var isEdit = !!existing;
      var e = existing || { nom: "", adresse: "", ville: "", codePostal: "", responsable: "", telephone: "", email: "", capacite: "", horaires: "", rayonKm: "", notes: "", tags: [] };

      LM.openModal({
        title: isEdit ? "Modifier l'entrepôt" : "Ajouter un entrepôt",
        wide: true,
        bodyHtml:
          '<form id="entForm">' +
            '<div class="form-row">' +
              field("Nom de l'entrepôt *", 'nom', e.nom, "text", true) +
              field("Ville *", 'ville', e.ville, "text", true) +
            '</div>' +
            '<div class="form-row">' +
              field("Adresse", 'adresse', e.adresse) +
              field("Code postal", 'codePostal', e.codePostal) +
            '</div>' +
            '<div class="form-row">' +
              field("Responsable", 'responsable', e.responsable) +
              field("Horaires", 'horaires', e.horaires, "text", false, "ex : 6h - 20h") +
            '</div>' +
            '<div class="form-row">' +
              field("Téléphone", 'telephone', e.telephone) +
              field("Email", 'email', e.email, "email") +
            '</div>' +
            '<div class="form-row">' +
              field("Capacité de stockage (nb de bacs)", 'capacite', e.capacite, "number") +
              field("Rayon de couverture (km)", 'rayonKm', e.rayonKm, "number", false, "Utilisé sur la carte des zones géographiques") +
            '</div>' +
            field("Tags / anciens noms", "tags", Array.isArray(e.tags) ? e.tags.join(", ") : "", "text", false, "Anciens noms de cet entrepôt (renommage, fusion de sites…), séparés par des virgules. Permet aux imports Excel de continuer à reconnaître l'entrepôt même si son nom a changé.") +
            '<div class="field"><label>Notes</label><textarea name="notes">' + LM.escapeHtml(e.notes || "") + '</textarea></div>' +
            (isEdit ? '<p class="text-sm text-faint">Position sur la carte : modifiable par glisser-déposer depuis la page <strong>Zones géographiques</strong>.</p>' : '') +
          '</form>',
        footerHtml: '<button class="btn btn-secondary" id="cancelBtn">Annuler</button><button class="btn btn-primary" id="saveBtn">' + (isEdit ? "Enregistrer" : "Ajouter") + '</button>',
        onMount: function (modal) {
          modal.querySelector("#cancelBtn").addEventListener("click", LM.closeModal);
          modal.querySelector("#saveBtn").addEventListener("click", function () {
            var form = modal.querySelector("#entForm");
            var fd = new FormData(form);
            var nom = (fd.get("nom") || "").toString().trim();
            var ville = (fd.get("ville") || "").toString().trim();
            if (!nom || !ville) { LM.toast("Le nom et la ville sont obligatoires.", "danger"); return; }
            var tags = (fd.get("tags") || "").toString().split(",")
              .map(function (t) { return t.trim(); })
              .filter(function (t) { return t.length > 0; });
            var payload = {
              nom: nom, ville: ville,
              adresse: (fd.get("adresse") || "").toString().trim(),
              codePostal: (fd.get("codePostal") || "").toString().trim(),
              responsable: (fd.get("responsable") || "").toString().trim(),
              horaires: (fd.get("horaires") || "").toString().trim(),
              telephone: (fd.get("telephone") || "").toString().trim(),
              email: (fd.get("email") || "").toString().trim(),
              capacite: Number(fd.get("capacite")) || 0,
              rayonKm: Number(fd.get("rayonKm")) || 0,
              tags: tags,
              notes: (fd.get("notes") || "").toString().trim()
            };
            var targetId = isEdit ? e.id : null;
            if (isEdit) {
              DB.update("entrepots", e.id, payload);
              var changes = DB.summarizeFieldChanges(e, payload, { adresse: "Adresse", codePostal: "Code postal", ville: "Ville", responsable: "Responsable", telephone: "Téléphone", email: "Email", capacite: "Capacité" });
              DB.logHistorique("Entrepôts", "modification", "Modification entrepôt : " + nom + (changes ? " -> " + changes : ""));
            } else {
              payload.x = 50; payload.y = 50;
              targetId = DB.add("entrepots", payload).id;
              DB.logHistorique("Entrepôts", "ajout", "Ajout entrepôt : " + nom);
            }
            var reattached = DB.reattachOrphanLivraisonsEntrepot(targetId);
            var msg = isEdit ? "Entrepôt mis à jour." : "Entrepôt ajouté. Placez-le sur la carte depuis la page Zones géographiques.";
            if (reattached > 0) { msg += " " + reattached + " livraison(s) passée(s) rattachée(s) grâce aux tags."; }
            LM.toast(msg, "success");
            LM.closeModal();
            render(content);
          });
        }
      });
    }
  }

  function field(label, name, value, type, required, hint) {
    type = type || "text";
    return '<div class="field"><label>' + label + '</label>' +
      '<input type="' + type + '" name="' + name + '" value="' + LM.escapeHtml(value !== undefined && value !== null ? value : "") + '"' + (required ? " required" : "") + ' />' +
      (hint ? '<div class="hint">' + hint + '</div>' : '') +
      '</div>';
  }

  function kpi(iconName, label, value) {
    return '<div class="kpi"><div class="kpi-label"><span class="kpi-icon">' + LM.icon(iconName) + '</span>' + label + '</div><div class="kpi-value">' + value + '</div></div>';
  }
})();


/* ==== js/livreurs.js ==== */
/*! livreurs.js - Page de gestion des livreurs */
(function () {
  "use strict";

  var STATUTS = {
    actif: { label: "Actif", cls: "badge-success" },
    conge: { label: "En congé", cls: "badge-info" },
    arret: { label: "Arrêt / absent", cls: "badge-warning" },
    inactif: { label: "Inactif", cls: "badge-muted" }
  };

  var filters = { entrepot: "", statut: "", q: "" };

  App.registerPage("livreurs", { title: "Livreurs", subtitle: "Équipe de livraison, affectations et statuts", render: render });

  function render(content) {
    var livreurs = DB.list("livreurs");
    var entrepots = DB.list("entrepots");
    var actifs = livreurs.filter(function (l) { return l.statut === "actif"; }).length;
    var indispo = livreurs.filter(function (l) { return l.statut === "conge" || l.statut === "arret"; }).length;

    content.innerHTML =
      '<div class="grid grid-4" style="margin-bottom:22px;">' +
        kpi("livreur", "Livreurs au total", DB.fmtNum(livreurs.length)) +
        kpi("check", "Actifs", DB.fmtNum(actifs)) +
        kpi("alert", "Indisponibles", DB.fmtNum(indispo)) +
        kpi("entrepot", "Entrepôts couverts", DB.fmtNum(entrepots.length)) +
      '</div>' +
      '<div class="card">' +
        '<div class="card-header"><div><h2>Équipe de livraison</h2><p>Gérez l\'affectation des livreurs aux entrepôts et véhicules.</p></div>' +
        '<button class="btn btn-primary" id="btnAdd">' + LM.icon("plus") + ' Ajouter un livreur</button></div>' +
        '<div class="form-row" style="margin-bottom:16px;">' +
          '<div class="field mb-0"><label>Recherche</label><input type="search" id="fq" placeholder="Nom, zone…" /></div>' +
          '<div class="field mb-0"><label>Entrepôt</label><select id="fEnt"><option value="">Tous les entrepôts</option>' +
            entrepots.map(function (e) { return '<option value="' + e.id + '">' + LM.escapeHtml(e.nom) + '</option>'; }).join("") +
          '</select></div>' +
          '<div class="field mb-0"><label>Statut</label><select id="fStatut"><option value="">Tous les statuts</option>' +
            Object.keys(STATUTS).map(function (k) { return '<option value="' + k + '">' + STATUTS[k].label + '</option>'; }).join("") +
          '</select></div>' +
        '</div>' +
        '<div class="table-wrap"><table><thead><tr>' +
          '<th>Livreur</th><th>Entrepôt</th><th>Véhicule</th><th>Zone</th><th>Statut</th><th>Embauche</th><th></th>' +
        '</tr></thead><tbody id="tbody"></tbody></table></div>' +
      '</div>';

    document.getElementById("btnAdd").addEventListener("click", function () { openForm(null); });
    document.getElementById("fq").addEventListener("input", function (e) { filters.q = e.target.value; renderRows(); });
    document.getElementById("fEnt").addEventListener("change", function (e) { filters.entrepot = e.target.value; renderRows(); });
    document.getElementById("fStatut").addEventListener("change", function (e) { filters.statut = e.target.value; renderRows(); });

    renderRows();

    function renderRows() {
      var tbody = document.getElementById("tbody");
      var q = DB.normalizeStr(filters.q);
      var rows = DB.list("livreurs").filter(function (l) {
        if (filters.entrepot && !DB.livreurAEntrepot(l, filters.entrepot)) return false;
        if (filters.statut && l.statut !== filters.statut) return false;
        var tagsStr = Array.isArray(l.tags) ? l.tags.join(" ") : "";
        if (q && DB.normalizeStr(DB.livreurNomComplet(l) + " " + (l.zone || "") + " " + tagsStr).indexOf(q) === -1) return false;
        return true;
      });

      if (!rows.length) {
        tbody.innerHTML = '<tr class="empty-row"><td colspan="7">Aucun livreur ne correspond aux filtres.</td></tr>';
        return;
      }

      tbody.innerHTML = rows.map(function (l) {
        var ents = (Array.isArray(l.entrepotIds) ? l.entrepotIds : []).map(function (id) { return DB.get("entrepots", id); }).filter(Boolean);
        var veh = l.vehiculeId ? DB.get("vehicules", l.vehiculeId) : null;
        var statut = STATUTS[l.statut] || STATUTS.inactif;
        var initials = ((l.prenom || "?")[0] + (l.nom || "?")[0]).toUpperCase();
        var tagsHtml = (Array.isArray(l.tags) && l.tags.length) ?
          '<div class="text-faint text-sm" title="Anciens noms / comptes associés"><span class="icon-inline">' + LM.icon("tag") + '</span>' + l.tags.map(function (t) { return LM.escapeHtml(t); }).join(", ") + '</div>' : "";
        return '<tr>' +
          '<td><div class="flex gap-10" style="align-items:center;"><span class="avatar">' + initials + '</span>' +
            '<div><strong>' + LM.escapeHtml(DB.livreurNomComplet(l)) + '</strong><div class="text-faint text-sm">' + LM.escapeHtml(l.telephone || "") + '</div>' + tagsHtml + '</div></div></td>' +
          '<td>' + (ents.length ? ents.map(function (e) { return LM.escapeHtml(e.nom); }).join(", ") : '<span class="text-faint">Non rattaché</span>') + '</td>' +
          '<td>' + (veh ? LM.escapeHtml(veh.plaque) + '<div class="text-faint text-sm">' + LM.escapeHtml(veh.type) + '</div>' : '<span class="text-faint">Aucun</span>') + '</td>' +
          '<td class="text-sm">' + LM.escapeHtml(l.zone || "—") + '</td>' +
          '<td><span class="badge ' + statut.cls + '">' + statut.label + '</span></td>' +
          '<td class="text-sm">' + DB.fmtDate(l.dateEmbauche) + '</td>' +
          '<td class="actions">' +
            '<button class="btn btn-ghost btn-sm btn-icon" data-edit="' + l.id + '" title="Modifier">' + LM.icon("edit") + '</button>' +
            '<button class="btn btn-ghost btn-sm btn-icon" data-del="' + l.id + '" title="Supprimer">' + LM.icon("trash") + '</button>' +
          '</td></tr>';
      }).join("");

      tbody.querySelectorAll("[data-edit]").forEach(function (btn) {
        btn.addEventListener("click", function () { openForm(DB.get("livreurs", btn.getAttribute("data-edit"))); });
      });
      tbody.querySelectorAll("[data-del]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var id = btn.getAttribute("data-del");
          var l = DB.get("livreurs", id);
          LM.confirmDialog("Supprimer <strong>" + LM.escapeHtml(DB.livreurNomComplet(l)) + "</strong> ? L'historique de livraisons associé sera conservé.", function () {
            DB.remove("livreurs", id);
            DB.logHistorique("Livreurs", "suppression", "Suppression livreur : " + DB.livreurNomComplet(l));
            LM.toast("Livreur supprimé.", "success");
            render(content);
          });
        });
      });
    }

    function openForm(existing) {
      var isEdit = !!existing;
      var l = existing || { prenom: "", nom: "", telephone: "", email: "", entrepotIds: [], vehiculeId: "", statut: "actif", dateEmbauche: DB.todayISO(), permis: "B", zone: "", notes: "", tags: [] };
      var entrepots = DB.list("entrepots");

      // Un livreur peut être rattaché à plusieurs entrepôts : entIds est toujours un tableau
      // (éventuellement vide). Les véhicules proposés sont ceux de l'un de ces entrepôts,
      // plus le matériel/véhicules marqués "Tous les entrepôts".
      function vehiculeOptions(entIds, selected) {
        entIds = entIds || [];
        var vehicules = DB.list("vehicules").filter(function (v) {
          return !entIds.length || entIds.indexOf(v.entrepotId) !== -1 || v.entrepotId === DB.ENTREPOT_TOUS;
        });
        return '<option value="">Aucun</option>' + vehicules.map(function (v) {
          return '<option value="' + v.id + '"' + (v.id === selected ? " selected" : "") + '>' + LM.escapeHtml(v.plaque) + ' (' + v.type + ')</option>';
        }).join("");
      }

      LM.openModal({
        title: isEdit ? "Modifier le livreur" : "Ajouter un livreur",
        wide: true,
        bodyHtml:
          '<form id="livForm">' +
            '<div class="form-row">' +
              field("Prénom *", "prenom", l.prenom, "text", true) +
              field("Nom *", "nom", l.nom, "text", true) +
            '</div>' +
            '<div class="form-row">' +
              field("Téléphone", "telephone", l.telephone) +
              field("Email", "email", l.email, "email") +
            '</div>' +
            '<div class="form-row">' +
              '<div class="field"><label>Entrepôts de rattachement</label><select name="entrepotIds" id="entSelect" multiple size="4">' +
                entrepots.map(function (e) { return '<option value="' + e.id + '"' + ((l.entrepotIds || []).indexOf(e.id) !== -1 ? " selected" : "") + '>' + LM.escapeHtml(e.nom) + '</option>'; }).join("") +
              '</select><div class="hint">Maintenez Ctrl (Cmd sur Mac) enfoncé pour sélectionner plusieurs entrepôts — un livreur peut être rattaché à plusieurs sites.</div></div>' +
              '<div class="field"><label>Véhicule assigné</label><select name="vehiculeId" id="vehSelect">' + vehiculeOptions(l.entrepotIds, l.vehiculeId) + '</select></div>' +
            '</div>' +
            '<div class="form-row">' +
              '<div class="field"><label>Statut</label><select name="statut">' +
                Object.keys(STATUTS).map(function (k) { return '<option value="' + k + '"' + (k === l.statut ? " selected" : "") + '>' + STATUTS[k].label + '</option>'; }).join("") +
              '</select></div>' +
              field("Date d'embauche", "dateEmbauche", l.dateEmbauche, "date") +
            '</div>' +
            '<div class="form-row">' +
              field("Permis", "permis", l.permis, "text", false, "ex : B, A2, C…") +
              field("Zone de livraison", "zone", l.zone, "text", false, "ex : Paris Nord / Saint-Denis") +
            '</div>' +
            field("Tags / anciens noms", "tags", Array.isArray(l.tags) ? l.tags.join(", ") : "", "text", false, "Anciens noms ou comptes recréés associés à ce livreur, séparés par des virgules. Utile si le site d'export vous oblige à recréer un compte : ajoutez l'ancien nom ici pour que les imports Excel continuent de le reconnaître.") +
            '<div class="field"><label>Notes</label><textarea name="notes">' + LM.escapeHtml(l.notes || "") + '</textarea></div>' +
          '</form>',
        footerHtml: '<button class="btn btn-secondary" id="cancelBtn">Annuler</button><button class="btn btn-primary" id="saveBtn">' + (isEdit ? "Enregistrer" : "Ajouter") + '</button>',
        onMount: function (modal) {
          modal.querySelector("#entSelect").addEventListener("change", function (e) {
            var selected = Array.from(e.target.selectedOptions).map(function (o) { return o.value; });
            modal.querySelector("#vehSelect").innerHTML = vehiculeOptions(selected, null);
          });
          modal.querySelector("#cancelBtn").addEventListener("click", LM.closeModal);
          modal.querySelector("#saveBtn").addEventListener("click", function () {
            var form = modal.querySelector("#livForm");
            var fd = new FormData(form);
            var prenom = (fd.get("prenom") || "").toString().trim();
            var nom = (fd.get("nom") || "").toString().trim();
            if (!prenom || !nom) { LM.toast("Le prénom et le nom sont obligatoires.", "danger"); return; }
            var tags = (fd.get("tags") || "").toString().split(",")
              .map(function (t) { return t.trim(); })
              .filter(function (t) { return t.length > 0; });
            var payload = {
              prenom: prenom, nom: nom,
              telephone: (fd.get("telephone") || "").toString().trim(),
              email: (fd.get("email") || "").toString().trim(),
              entrepotIds: fd.getAll("entrepotIds").filter(Boolean),
              vehiculeId: (fd.get("vehiculeId") || "") || null,
              statut: fd.get("statut"),
              dateEmbauche: fd.get("dateEmbauche"),
              permis: (fd.get("permis") || "").toString().trim(),
              zone: (fd.get("zone") || "").toString().trim(),
              tags: tags,
              notes: (fd.get("notes") || "").toString().trim()
            };
            var targetId = isEdit ? l.id : null;
            var nomComplet = prenom + " " + nom;
            if (isEdit) {
              DB.update("livreurs", l.id, payload);
              var changes = DB.summarizeFieldChanges(l, payload, { telephone: "Téléphone", email: "Email", zone: "Zone", dateEmbauche: "Date d'embauche", permis: "Permis" });
              DB.logHistorique("Livreurs", "modification", "Modification livreur : " + nomComplet + (changes ? " -> " + changes : ""));
            } else {
              targetId = DB.add("livreurs", payload).id;
              DB.logHistorique("Livreurs", "ajout", "Ajout livreur : " + nomComplet);
            }
            var reattached = DB.reattachOrphanLivraisons(targetId);
            var msg = isEdit ? "Livreur mis à jour." : "Livreur ajouté.";
            if (reattached > 0) { msg += " " + reattached + " livraison(s) passée(s) rattachée(s) grâce aux tags."; }
            LM.toast(msg, "success");
            LM.closeModal();
            render(content);
          });
        }
      });
    }
  }

  function field(label, name, value, type, required, hint) {
    type = type || "text";
    return '<div class="field"><label>' + label + '</label>' +
      '<input type="' + type + '" name="' + name + '" value="' + LM.escapeHtml(value !== undefined && value !== null ? value : "") + '"' + (required ? " required" : "") + ' />' +
      (hint ? '<div class="hint">' + hint + '</div>' : '') +
      '</div>';
  }

  function kpi(iconName, label, value) {
    return '<div class="kpi"><div class="kpi-label"><span class="kpi-icon">' + LM.icon(iconName) + '</span>' + label + '</div><div class="kpi-value">' + value + '</div></div>';
  }
})();



/* ==== js/materiel.js ==== */
/*! materiel.js - Page de gestion du matériel (véhicules + autre matériel) */
(function () {
  "use strict";

  // Les types de véhicules et catégories de matériel sont désormais des listes de référence
  // personnalisables depuis la page Annexes (DB.listeItems/listeLabel) plutôt que des objets figés,
  // afin de permettre à l'utilisateur d'ajouter ses propres catégories (ex. pièces mécaniques).
  function vehTypeLabel(key) { return DB.listeLabel("typesVehicule", key) || key || "—"; }
  function vehTypeOptions(selectedKey) {
    return DB.listeItems("typesVehicule").map(function (t) {
      return '<option value="' + t.key + '"' + (t.key === selectedKey ? " selected" : "") + '>' + LM.escapeHtml(t.label) + '</option>';
    }).join("");
  }
  function matCatLabel(key) { return DB.listeLabel("categoriesMateriel", key) || key || "—"; }
  function matCatOptions(selectedKey) {
    return DB.listeItems("categoriesMateriel").map(function (c) {
      return '<option value="' + c.key + '"' + (c.key === selectedKey ? " selected" : "") + '>' + LM.escapeHtml(c.label) + '</option>';
    }).join("");
  }

  var VEH_STATUTS = {
    service: { label: "En service", cls: "badge-success" },
    maintenance: { label: "En maintenance", cls: "badge-warning" },
    hors_service: { label: "Hors service", cls: "badge-danger" }
  };
  var MAT_ETATS = {
    bon: { label: "Bon état", cls: "badge-success" },
    moyen: { label: "État moyen", cls: "badge-warning" },
    a_remplacer: { label: "À remplacer", cls: "badge-danger" }
  };
  var activeTab = "vehicules";

  App.registerPage("materiel", { title: "Matériel", subtitle: "Véhicules et équipements de livraison", render: render });

  function render(content) {
    var vehicules = DB.list("vehicules");
    var materiels = DB.list("materiels");
    var enService = vehicules.filter(function (v) { return v.statut === "service"; }).length;
    var enPanne = vehicules.filter(function (v) { return v.statut !== "service"; }).length;
    var totalBacs = materiels.filter(function (m) { return m.categorie === "bacs"; }).reduce(function (a, m) { return a + (Number(m.quantite) || 0); }, 0);

    var soonDate = new Date(); soonDate.setDate(soonDate.getDate() + 14);
    var entretiensProches = vehicules.filter(function (v) { return v.prochainEntretien && new Date(v.prochainEntretien) <= soonDate; }).length;

    content.innerHTML =
      '<div class="grid grid-4" style="margin-bottom:22px;">' +
        kpi("truck", "Véhicules", DB.fmtNum(vehicules.length)) +
        kpi("check", "En service", DB.fmtNum(enService)) +
        kpi("alert", "Entretiens proches / en panne", DB.fmtNum(entretiensProches + enPanne)) +
        kpi("box", "Bacs en stock", DB.fmtNum(totalBacs)) +
      '</div>' +
      '<div class="card">' +
        '<div class="tabs">' +
          '<button class="tab-btn' + (activeTab === "vehicules" ? " active" : "") + '" data-tab="vehicules">Véhicules</button>' +
          '<button class="tab-btn' + (activeTab === "materiels" ? " active" : "") + '" data-tab="materiels">Autre matériel</button>' +
        '</div>' +
        '<div id="tabVehicules" class="tab-panel' + (activeTab === "vehicules" ? " active" : "") + '"></div>' +
        '<div id="tabMateriels" class="tab-panel' + (activeTab === "materiels" ? " active" : "") + '"></div>' +
      '</div>';

    content.querySelectorAll(".tab-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        activeTab = btn.getAttribute("data-tab");
        render(content);
      });
    });

    renderVehicules(document.getElementById("tabVehicules"));
    renderMateriels(document.getElementById("tabMateriels"));
  }

  // ------------------------------------------------------------------
  // Véhicules
  // ------------------------------------------------------------------
  function renderVehicules(panel) {
    var entrepots = DB.list("entrepots");
    panel.innerHTML =
      '<div class="card-header" style="margin-top:6px;"><div><h3>Parc de véhicules</h3><p class="text-sm">Suivi de l\'état, du kilométrage et de l\'entretien.</p></div>' +
      '<div class="flex gap-8">' +
        '<button class="btn btn-pdf" id="btnExportFleetPdf">' + LM.icon("file") + ' Exporter le parc en PDF</button>' +
        '<button class="btn btn-primary" id="btnAddVeh">' + LM.icon("plus") + ' Ajouter un véhicule</button>' +
      '</div></div>' +
      '<div class="table-wrap"><table><thead><tr>' +
        '<th>Plaque</th><th>Type</th><th>Entrepôt</th><th>Statut</th><th class="num">Km</th><th>Prochain entretien</th><th></th>' +
      '</tr></thead><tbody id="tbodyVeh"></tbody></table></div>';

    document.getElementById("btnAddVeh").addEventListener("click", function () { openVehForm(null); });
    document.getElementById("btnExportFleetPdf").addEventListener("click", exportFleetPdf);
    renderRows();

    function renderRows() {
      var tbody = document.getElementById("tbodyVeh");
      var rows = DB.list("vehicules");
      if (!rows.length) { tbody.innerHTML = '<tr class="empty-row"><td colspan="7">Aucun véhicule enregistré.</td></tr>'; return; }
      var soonDate = new Date(); soonDate.setDate(soonDate.getDate() + 14);

      tbody.innerHTML = rows.map(function (v) {
        var ent = (v.entrepotId && v.entrepotId !== DB.ENTREPOT_TOUS) ? DB.get("entrepots", v.entrepotId) : null;
        var entLabel = v.entrepotId === DB.ENTREPOT_TOUS ? '<span class="badge badge-info">Tous les entrepôts</span>' : (ent ? LM.escapeHtml(ent.nom) : '<span class="text-faint">—</span>');
        var statut = VEH_STATUTS[v.statut] || VEH_STATUTS.service;
        var entretienSoon = v.prochainEntretien && new Date(v.prochainEntretien) <= soonDate;
        return '<tr>' +
          '<td><strong>' + LM.escapeHtml(v.plaque) + '</strong></td>' +
          '<td>' + vehTypeLabel(v.type) + '</td>' +
          '<td>' + entLabel + '</td>' +
          '<td><span class="badge ' + statut.cls + '">' + statut.label + '</span></td>' +
          '<td class="num">' + DB.fmtNum(v.km) + '</td>' +
          '<td class="text-sm">' + DB.fmtDate(v.prochainEntretien) + (entretienSoon ? ' <span class="badge badge-warning">Bientôt</span>' : '') + '</td>' +
          '<td class="actions">' +
            '<button class="btn btn-ghost btn-sm btn-icon" data-hist="' + v.id + '" title="Historique des réparations">' + LM.icon("clock") + '</button>' +
            '<button class="btn btn-ghost btn-sm btn-icon" data-controle="' + v.id + '" title="Nouveau contrôle général (check préventif)">' + LM.icon("eye") + '</button>' +
            '<button class="btn btn-ghost btn-sm btn-icon" data-ticket="' + v.id + '" title="Créer un ticket de réparation">' + LM.icon("wrench") + '</button>' +
            '<button class="btn btn-ghost btn-sm btn-icon" data-edit="' + v.id + '" title="Modifier">' + LM.icon("edit") + '</button>' +
            '<button class="btn btn-ghost btn-sm btn-icon" data-del="' + v.id + '" title="Supprimer">' + LM.icon("trash") + '</button>' +
          '</td></tr>';
      }).join("");

      tbody.querySelectorAll("[data-hist]").forEach(function (btn) {
        btn.addEventListener("click", function () { openVehiculeHistoryModal(DB.get("vehicules", btn.getAttribute("data-hist"))); });
      });
      tbody.querySelectorAll("[data-controle]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          App.pendingTicketRequest = { type: "vehicule", id: btn.getAttribute("data-controle"), nature: "controle" };
          location.hash = "#/reparations";
        });
      });
      tbody.querySelectorAll("[data-ticket]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          App.pendingTicketRequest = { type: "vehicule", id: btn.getAttribute("data-ticket") };
          location.hash = "#/reparations";
        });
      });
      tbody.querySelectorAll("[data-edit]").forEach(function (btn) {
        btn.addEventListener("click", function () { openVehForm(DB.get("vehicules", btn.getAttribute("data-edit"))); });
      });
      tbody.querySelectorAll("[data-del]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var id = btn.getAttribute("data-del");
          var v = DB.get("vehicules", id);
          var nbLivreurs = DB.list("livreurs").filter(function (l) { return l.vehiculeId === id; }).length;
          LM.confirmDialog("Supprimer le véhicule <strong>" + LM.escapeHtml(v.plaque) + "</strong> ?" + (nbLivreurs ? " " + nbLivreurs + " livreur(s) en seront détachés." : ""), function () {
            if (nbLivreurs) {
              DB.list("livreurs").filter(function (l) { return l.vehiculeId === id; }).forEach(function (l) { DB.update("livreurs", l.id, { vehiculeId: null }); });
            }
            DB.remove("vehicules", id);
            DB.logHistorique("Matériel", "suppression", "Suppression véhicule : " + v.plaque);
            LM.toast("Véhicule supprimé.", "success");
            renderRows();
          });
        });
      });
    }

    function openVehForm(existing) {
      var isEdit = !!existing;
      var v = existing || { plaque: "", type: "camionnette", entrepotId: "", statut: "service", km: "", dateAchat: "", prochainEntretien: "", notes: "" };
      LM.openModal({
        title: isEdit ? "Modifier le véhicule" : "Ajouter un véhicule",
        wide: true,
        bodyHtml:
          '<form id="vehForm">' +
            '<div class="form-row">' +
              field("Plaque d'immatriculation *", "plaque", v.plaque, "text", true) +
              '<div class="field"><label>Type</label><select name="type">' +
                vehTypeOptions(v.type) +
              '</select></div>' +
            '</div>' +
            '<div class="form-row">' +
              '<div class="field"><label>Entrepôt</label><select name="entrepotId"><option value="">Aucun</option>' +
                '<option value="' + DB.ENTREPOT_TOUS + '"' + (v.entrepotId === DB.ENTREPOT_TOUS ? " selected" : "") + '>Tous les entrepôts</option>' +
                DB.list("entrepots").map(function (e) { return '<option value="' + e.id + '"' + (e.id === v.entrepotId ? " selected" : "") + '>' + LM.escapeHtml(e.nom) + '</option>'; }).join("") +
              '</select></div>' +
              '<div class="field"><label>Statut</label><select name="statut">' +
                Object.keys(VEH_STATUTS).map(function (k) { return '<option value="' + k + '"' + (k === v.statut ? " selected" : "") + '>' + VEH_STATUTS[k].label + '</option>'; }).join("") +
              '</select></div>' +
            '</div>' +
            '<div class="form-row">' +
              field("Kilométrage", "km", v.km, "number") +
              field("Date d'achat", "dateAchat", v.dateAchat, "date") +
            '</div>' +
            field("Prochain entretien", "prochainEntretien", v.prochainEntretien, "date") +
            '<div class="field"><label>Notes</label><textarea name="notes">' + LM.escapeHtml(v.notes || "") + '</textarea></div>' +
          '</form>',
        footerHtml: '<button class="btn btn-secondary" id="cancelBtn">Annuler</button><button class="btn btn-primary" id="saveBtn">' + (isEdit ? "Enregistrer" : "Ajouter") + '</button>',
        onMount: function (modal) {
          modal.querySelector("#cancelBtn").addEventListener("click", LM.closeModal);
          modal.querySelector("#saveBtn").addEventListener("click", function () {
            var fd = new FormData(modal.querySelector("#vehForm"));
            var plaque = (fd.get("plaque") || "").toString().trim();
            if (!plaque) { LM.toast("La plaque d'immatriculation est obligatoire.", "danger"); return; }
            var payload = {
              plaque: plaque, type: fd.get("type"),
              entrepotId: fd.get("entrepotId") || null,
              statut: fd.get("statut"),
              km: Number(fd.get("km")) || 0,
              dateAchat: fd.get("dateAchat"),
              prochainEntretien: fd.get("prochainEntretien"),
              notes: (fd.get("notes") || "").toString().trim()
            };
            if (isEdit) {
              DB.update("vehicules", v.id, payload);
              var changes = DB.summarizeFieldChanges(v, payload, { plaque: "Plaque", statut: "Statut", km: "Kilométrage", prochainEntretien: "Prochain entretien" });
              DB.logHistorique("Matériel", "modification", "Modification véhicule : " + plaque + (changes ? " -> " + changes : ""));
              LM.toast("Véhicule mis à jour.", "success");
            } else {
              DB.add("vehicules", payload);
              DB.logHistorique("Matériel", "ajout", "Ajout véhicule : " + plaque);
              LM.toast("Véhicule ajouté.", "success");
            }
            LM.closeModal();
            render(document.getElementById("content"));
          });
        }
      });
    }
  }

  // ------------------------------------------------------------------
  // Historique complet des réparations d'un véhicule
  // ------------------------------------------------------------------
  // Libellés locaux (non partagés avec reparations.js pour ne pas créer de dépendance
  // entre fichiers, à l'image de VEH_STATUT_LABELS déjà dupliqué côté reparations.js).
  var TICKET_STATUT_LABELS = { nouveau: "À réparer", en_cours: "En réparation", termine: "Réparé", annule: "Annulé" };
  var TICKET_STATUT_CLS = { nouveau: "badge-info", en_cours: "badge-warning", termine: "badge-success", annule: "badge-muted" };
  var TICKET_PRIO_LABELS = { basse: "Basse", normale: "Normale", haute: "Haute", urgente: "Urgente" };
  var TICKET_PRIO_CLS = { basse: "badge-muted", normale: "badge-info", haute: "badge-warning", urgente: "badge-danger" };
  var TICKET_NATURE_LABELS = { reparation: "Réparation", controle: "Contrôle" };
  var TICKET_NATURE_CLS = { reparation: "badge-info", controle: "badge-accent" };

  function openVehiculeHistoryModal(v) {
    if (!v) return;
    var tickets = DB.list("ticketsReparation").filter(function (t) { return t.materielType === "vehicule" && t.materielId === v.id; })
      .sort(function (a, b) { return (b.dateCreation || "").localeCompare(a.dateCreation || ""); });
    var nbOuverts = tickets.filter(function (t) { return t.statut === "nouveau" || t.statut === "en_cours"; }).length;
    var nbControles = tickets.filter(function (t) { return t.nature === "controle"; }).length;
    var coutTotal = tickets.reduce(function (a, t) { return a + (Number(t.cout) || 0); }, 0);
    var statut = VEH_STATUTS[v.statut] || VEH_STATUTS.service;

    var rowsHtml = tickets.length ? tickets.map(function (t) {
      var nature = t.nature || "reparation";
      return '<tr>' +
        '<td class="text-faint text-sm">' + LM.escapeHtml(DB.fmtTicketRef(t.ticketNumber)) + '</td>' +
        '<td><span class="badge ' + TICKET_NATURE_CLS[nature] + '">' + TICKET_NATURE_LABELS[nature] + '</span></td>' +
        '<td><strong>' + LM.escapeHtml(t.titre) + '</strong>' + (t.immobilise ? ' <span class="badge badge-danger">Immobilisant</span>' : '') + '</td>' +
        '<td><span class="badge ' + (TICKET_PRIO_CLS[t.priorite] || "badge-info") + '">' + (TICKET_PRIO_LABELS[t.priorite] || t.priorite) + '</span></td>' +
        '<td><span class="badge ' + (TICKET_STATUT_CLS[t.statut] || "badge-muted") + '">' + (TICKET_STATUT_LABELS[t.statut] || t.statut) + '</span></td>' +
        '<td class="text-sm">' + DB.fmtDate(t.dateCreation) + '</td>' +
        '<td class="text-sm">' + (t.dateFin ? DB.fmtDate(t.dateFin) : '<span class="text-faint">—</span>') + '</td>' +
        '<td class="num">' + (t.cout !== "" && t.cout !== undefined && t.cout !== null ? DB.fmtEUR(t.cout) : '—') + '</td>' +
        '<td class="actions"><button class="btn btn-ghost btn-sm btn-icon" data-openticket="' + t.id + '" title="Voir le ticket dans Réparations">' + LM.icon("edit") + '</button></td>' +
      '</tr>';
    }).join("") : '<tr class="empty-row"><td colspan="9">Aucun ticket de réparation pour ce véhicule.</td></tr>';

    LM.openModal({
      title: "Historique des réparations — " + LM.escapeHtml(v.plaque),
      wide: true,
      bodyHtml:
        '<p class="text-sm text-faint" style="margin-top:0;">' + LM.escapeHtml(vehTypeLabel(v.type)) + ' · <span class="badge ' + statut.cls + '">' + statut.label + '</span> · ' + DB.fmtNum(v.km) + ' km</p>' +
        '<div class="grid grid-4" style="margin-bottom:18px;">' +
          kpi("wrench", "Tickets au total", DB.fmtNum(tickets.length)) +
          kpi("eye", "Dont contrôles", DB.fmtNum(nbControles)) +
          kpi("alert", "Tickets ouverts", DB.fmtNum(nbOuverts)) +
          kpi("euro", "Coût total réparations", DB.fmtEUR(coutTotal)) +
        '</div>' +
        '<div class="table-wrap"><table><thead><tr>' +
          '<th>Réf.</th><th>Nature</th><th>Titre</th><th>Priorité</th><th>Statut</th><th>Créé le</th><th>Terminé le</th><th class="num">Coût</th><th></th>' +
        '</tr></thead><tbody>' + rowsHtml + '</tbody></table></div>',
      footerHtml: '<button class="btn btn-secondary" id="closeHistBtn">Fermer</button>',
      onMount: function (modal) {
        modal.querySelector("#closeHistBtn").addEventListener("click", LM.closeModal);
        modal.querySelectorAll("[data-openticket]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            // Demande à la page Réparations d'ouvrir directement ce ticket existant en édition
            // (mécanisme jumeau de App.pendingTicketRequest, qui lui ne sert qu'à la création).
            App.pendingTicketOpenId = btn.getAttribute("data-openticket");
            LM.closeModal();
            location.hash = "#/reparations";
          });
        });
      }
    });
  }

  // ------------------------------------------------------------------
  // Export PDF du récapitulatif complet du parc de véhicules
  // ------------------------------------------------------------------
  function exportFleetPdf() {
    var vehicules = DB.list("vehicules");
    var entrepots = DB.list("entrepots");
    var enService = vehicules.filter(function (v) { return v.statut === "service"; }).length;
    var enMaintenance = vehicules.filter(function (v) { return v.statut === "maintenance"; }).length;
    var horsService = vehicules.filter(function (v) { return v.statut === "hors_service"; }).length;
    var kmTotal = vehicules.reduce(function (a, v) { return a + (Number(v.km) || 0); }, 0);
    var soonDate = new Date(); soonDate.setDate(soonDate.getDate() + 14);
    var entretiensProches = vehicules.filter(function (v) { return v.prochainEntretien && new Date(v.prochainEntretien) <= soonDate; }).length;

    var kpisHtml =
      '<div class="pr-kpis">' +
        '<div class="pr-kpi"><div class="pr-kpi-label">Véhicules</div><div class="pr-kpi-value">' + vehicules.length + '</div></div>' +
        '<div class="pr-kpi"><div class="pr-kpi-label">En service</div><div class="pr-kpi-value">' + enService + '</div></div>' +
        '<div class="pr-kpi"><div class="pr-kpi-label">En maintenance / hors service</div><div class="pr-kpi-value">' + (enMaintenance + horsService) + '</div></div>' +
        '<div class="pr-kpi"><div class="pr-kpi-label">Entretiens ≤ 14 j</div><div class="pr-kpi-value">' + entretiensProches + '</div></div>' +
      '</div>';

    var statutBadgeCls = { service: "pr-badge-success", maintenance: "pr-badge-warning", hors_service: "pr-badge-danger" };
    var tableHtml;
    if (!vehicules.length) {
      tableHtml = '<div class="pr-empty">Aucun véhicule enregistré.</div>';
    } else {
      var sorted = vehicules.slice().sort(function (a, b) { return (a.plaque || "").localeCompare(b.plaque || ""); });
      tableHtml =
        '<table class="pr-table"><thead><tr>' +
          '<th>Plaque</th><th>Type</th><th>Entrepôt</th><th>Statut</th><th>Km</th><th>Prochain entretien</th>' +
        '</tr></thead><tbody>' +
        sorted.map(function (v) {
          var ent = (v.entrepotId && v.entrepotId !== DB.ENTREPOT_TOUS) ? DB.get("entrepots", v.entrepotId) : null;
          var entLabel = v.entrepotId === DB.ENTREPOT_TOUS ? "Tous les entrepôts" : (ent ? ent.nom : "—");
          var statut = VEH_STATUTS[v.statut] || VEH_STATUTS.service;
          var soonFlag = v.prochainEntretien && new Date(v.prochainEntretien) <= soonDate;
          return '<tr>' +
            '<td><strong>' + LM.escapeHtml(v.plaque) + '</strong></td>' +
            '<td>' + LM.escapeHtml(vehTypeLabel(v.type)) + '</td>' +
            '<td>' + LM.escapeHtml(entLabel) + '</td>' +
            '<td><span class="pr-badge ' + (statutBadgeCls[v.statut] || "pr-badge-neutral") + '">' + statut.label + '</span></td>' +
            '<td>' + DB.fmtNum(v.km) + ' km</td>' +
            '<td>' + (v.prochainEntretien ? DB.fmtDate(v.prochainEntretien) : "—") + (soonFlag ? ' <span class="pr-badge pr-badge-warning">Bientôt</span>' : '') + '</td>' +
          '</tr>';
        }).join("") +
        '</tbody></table>';
    }

    var body = kpisHtml + '<div class="pr-section-title">Détail du parc (' + vehicules.length + ' véhicule(s))</div>' + tableHtml;
    LM.printReport("Récapitulatif du parc de véhicules", body, {
      subtitle: LM.escapeHtml(entrepots.length + " entrepôt(s) desservi(s) · " + DB.fmtNum(kmTotal) + " km cumulés au compteur")
    });
  }

  // ------------------------------------------------------------------
  // Autre matériel
  // ------------------------------------------------------------------
  function renderMateriels(panel) {
    panel.innerHTML =
      '<div class="card-header" style="margin-top:6px;"><div><h3>Autre matériel</h3><p class="text-sm">Bacs, chariots, scanners et équipements divers par entrepôt.</p></div>' +
      '<button class="btn btn-primary" id="btnAddMat">' + LM.icon("plus") + ' Ajouter du matériel</button></div>' +
      '<div class="table-wrap"><table><thead><tr>' +
        '<th>Matériel</th><th>Catégorie</th><th>Entrepôt</th><th class="num">Quantité</th><th>État</th><th></th>' +
      '</tr></thead><tbody id="tbodyMat"></tbody></table></div>';

    document.getElementById("btnAddMat").addEventListener("click", function () { openMatForm(null); });
    renderRows();

    function renderRows() {
      var tbody = document.getElementById("tbodyMat");
      var rows = DB.list("materiels");
      if (!rows.length) { tbody.innerHTML = '<tr class="empty-row"><td colspan="6">Aucun matériel enregistré.</td></tr>'; return; }
      tbody.innerHTML = rows.map(function (m) {
        var ent = (m.entrepotId && m.entrepotId !== DB.ENTREPOT_TOUS) ? DB.get("entrepots", m.entrepotId) : null;
        var entLabel = m.entrepotId === DB.ENTREPOT_TOUS ? '<span class="badge badge-info">Tous les entrepôts</span>' : (ent ? LM.escapeHtml(ent.nom) : '<span class="text-faint">—</span>');
        var etat = MAT_ETATS[m.etat] || MAT_ETATS.bon;
        return '<tr>' +
          '<td><strong>' + LM.escapeHtml(m.nom) + '</strong>' + (m.notes ? '<div class="text-faint text-sm">' + LM.escapeHtml(m.notes) + '</div>' : '') + '</td>' +
          '<td>' + matCatLabel(m.categorie) + '</td>' +
          '<td>' + entLabel + '</td>' +
          '<td class="num">' + DB.fmtNum(m.quantite) + '</td>' +
          '<td><span class="badge ' + etat.cls + '">' + etat.label + '</span></td>' +
          '<td class="actions">' +
            '<button class="btn btn-ghost btn-sm btn-icon" data-ticket="' + m.id + '" title="Créer un ticket de réparation">' + LM.icon("wrench") + '</button>' +
            '<button class="btn btn-ghost btn-sm btn-icon" data-edit="' + m.id + '" title="Modifier">' + LM.icon("edit") + '</button>' +
            '<button class="btn btn-ghost btn-sm btn-icon" data-del="' + m.id + '" title="Supprimer">' + LM.icon("trash") + '</button>' +
          '</td></tr>';
      }).join("");

      tbody.querySelectorAll("[data-ticket]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          App.pendingTicketRequest = { type: "materiel", id: btn.getAttribute("data-ticket") };
          location.hash = "#/reparations";
        });
      });
      tbody.querySelectorAll("[data-edit]").forEach(function (btn) {
        btn.addEventListener("click", function () { openMatForm(DB.get("materiels", btn.getAttribute("data-edit"))); });
      });
      tbody.querySelectorAll("[data-del]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var id = btn.getAttribute("data-del");
          var m = DB.get("materiels", id);
          LM.confirmDialog("Supprimer <strong>" + LM.escapeHtml(m.nom) + "</strong> ?", function () {
            DB.remove("materiels", id);
            DB.logHistorique("Matériel", "suppression", "Suppression matériel : " + m.nom);
            LM.toast("Matériel supprimé.", "success");
            renderRows();
          });
        });
      });
    }

    function openMatForm(existing) {
      var isEdit = !!existing;
      var m = existing || { nom: "", categorie: "bacs", quantite: "", entrepotId: "", etat: "bon", notes: "" };
      LM.openModal({
        title: isEdit ? "Modifier le matériel" : "Ajouter du matériel",
        bodyHtml:
          '<form id="matForm">' +
            field("Nom du matériel *", "nom", m.nom, "text", true) +
            '<div class="form-row">' +
              '<div class="field"><label>Catégorie</label><select name="categorie">' +
                matCatOptions(m.categorie) +
              '</select></div>' +
              field("Quantité", "quantite", m.quantite, "number") +
            '</div>' +
            '<div class="form-row">' +
              '<div class="field"><label>Entrepôt</label><select name="entrepotId"><option value="">Aucun</option>' +
                '<option value="' + DB.ENTREPOT_TOUS + '"' + (m.entrepotId === DB.ENTREPOT_TOUS ? " selected" : "") + '>Tous les entrepôts</option>' +
                DB.list("entrepots").map(function (e) { return '<option value="' + e.id + '"' + (e.id === m.entrepotId ? " selected" : "") + '>' + LM.escapeHtml(e.nom) + '</option>'; }).join("") +
              '</select></div>' +
              '<div class="field"><label>État</label><select name="etat">' +
                Object.keys(MAT_ETATS).map(function (k) { return '<option value="' + k + '"' + (k === m.etat ? " selected" : "") + '>' + MAT_ETATS[k].label + '</option>'; }).join("") +
              '</select></div>' +
            '</div>' +
            '<div class="field"><label>Notes</label><textarea name="notes">' + LM.escapeHtml(m.notes || "") + '</textarea></div>' +
          '</form>',
        footerHtml: '<button class="btn btn-secondary" id="cancelBtn">Annuler</button><button class="btn btn-primary" id="saveBtn">' + (isEdit ? "Enregistrer" : "Ajouter") + '</button>',
        onMount: function (modal) {
          modal.querySelector("#cancelBtn").addEventListener("click", LM.closeModal);
          modal.querySelector("#saveBtn").addEventListener("click", function () {
            var fd = new FormData(modal.querySelector("#matForm"));
            var nom = (fd.get("nom") || "").toString().trim();
            if (!nom) { LM.toast("Le nom du matériel est obligatoire.", "danger"); return; }
            var payload = {
              nom: nom, categorie: fd.get("categorie"),
              quantite: Number(fd.get("quantite")) || 0,
              entrepotId: fd.get("entrepotId") || null,
              etat: fd.get("etat"),
              notes: (fd.get("notes") || "").toString().trim()
            };
            if (isEdit) {
              DB.update("materiels", m.id, payload);
              var changes = DB.summarizeFieldChanges(m, payload, { nom: "Nom", categorie: "Catégorie", quantite: "Quantité", etat: "État" });
              DB.logHistorique("Matériel", "modification", "Modification matériel : " + nom + (changes ? " -> " + changes : ""));
              LM.toast("Matériel mis à jour.", "success");
            } else {
              DB.add("materiels", payload);
              DB.logHistorique("Matériel", "ajout", "Ajout matériel : " + nom);
              LM.toast("Matériel ajouté.", "success");
            }
            LM.closeModal();
            render(document.getElementById("content"));
          });
        }
      });
    }
  }

  function field(label, name, value, type, required, hint) {
    type = type || "text";
    return '<div class="field"><label>' + label + '</label>' +
      '<input type="' + type + '" name="' + name + '" value="' + LM.escapeHtml(value !== undefined && value !== null ? value : "") + '"' + (required ? " required" : "") + ' />' +
      (hint ? '<div class="hint">' + hint + '</div>' : '') +
      '</div>';
  }

  function kpi(iconName, label, value) {
    return '<div class="kpi"><div class="kpi-label"><span class="kpi-icon">' + LM.icon(iconName) + '</span>' + label + '</div><div class="kpi-value">' + value + '</div></div>';
  }
})();


/* ==== js/reparations.js ==== */
/*! reparations.js - Tickets de réparation (véhicules + autre matériel), suivi en Kanban et historique */
(function () {
  "use strict";

  var PRIORITES = {
    basse: { label: "Basse", cls: "badge-muted" },
    normale: { label: "Normale", cls: "badge-info" },
    haute: { label: "Haute", cls: "badge-warning" },
    urgente: { label: "Urgente", cls: "badge-danger" }
  };

  var STATUT_LABELS = { nouveau: "À réparer", en_cours: "En réparation", termine: "Réparé", annule: "Annulé" };

  // Un ticket peut représenter soit une réparation classique (suite à une panne signalée), soit un
  // contrôle général effectué spontanément par le réparateur (ex : vérification préventive d'un
  // vélo sans demande préalable). Les contrôles portent une check-list des parties inspectées.
  var NATURE_LABELS = { reparation: "Réparation", controle: "Contrôle / maintenance" };
  var NATURE_CLS = { reparation: "badge-info", controle: "badge-accent" };

  // Colonnes affichées en permanence dans le Kanban ; la colonne "Annulé" est optionnelle
  // (repliable) pour ne pas encombrer la vue de travail au quotidien.
  var COLONNES_BASE = [
    { key: "nouveau", label: "À réparer" },
    { key: "en_cours", label: "En réparation" },
    { key: "termine", label: "Réparé" }
  ];

  // Libellés d'état utilisés uniquement pour l'affichage dans le sélecteur de matériel du
  // formulaire de ticket (les vraies constantes vivent dans materiel.js, non partagées ici
  // pour ne pas créer de dépendance entre fichiers).
  var VEH_STATUT_LABELS = { service: "En service", maintenance: "En maintenance", hors_service: "Hors service" };
  var MAT_ETAT_LABELS = { bon: "Bon état", moyen: "État moyen", a_remplacer: "À remplacer" };

  var activeTab = "kanban";
  var kanbanFilters = { type: "", nature: "", q: "" };
  var showAnnules = false;
  var histFilters = { q: "", statut: "", periode: "tout", nature: "" };
  var statsFilters = { periode: "90j", start: "", end: "", type: "" };

  App.registerPage("reparations", { title: "Réparations", subtitle: "Tickets de réparation véhicules et matériel", render: render });

  function render(content) {
    content.innerHTML =
      '<div class="grid grid-4" id="kpiRow" style="margin-bottom:22px;"></div>' +
      '<div class="card">' +
        '<div class="card-header"><div><h2>Suivi des réparations</h2><p>Kanban de suivi et historique complet des tickets, tous matériels confondus.</p></div>' +
          '<button class="btn btn-pdf" id="btnExportTicketsPdf">' + LM.icon("file") + ' Exporter en PDF</button>' +
        '</div>' +
        '<div class="tabs">' +
          '<button class="tab-btn' + (activeTab === "kanban" ? " active" : "") + '" data-tab="kanban">Suivi (Kanban)</button>' +
          '<button class="tab-btn' + (activeTab === "historique" ? " active" : "") + '" data-tab="historique">Historique des réparations</button>' +
          '<button class="tab-btn' + (activeTab === "statistiques" ? " active" : "") + '" data-tab="statistiques">Statistiques</button>' +
        '</div>' +
        '<div id="tabKanban" class="tab-panel' + (activeTab === "kanban" ? " active" : "") + '"></div>' +
        '<div id="tabHistorique" class="tab-panel' + (activeTab === "historique" ? " active" : "") + '"></div>' +
        '<div id="tabStatistiques" class="tab-panel' + (activeTab === "statistiques" ? " active" : "") + '"></div>' +
      '</div>';

    content.querySelectorAll("[data-tab]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        activeTab = btn.getAttribute("data-tab");
        render(content);
      });
    });

    document.getElementById("btnExportTicketsPdf").addEventListener("click", openExportPdfModal);

    renderKpis();
    if (activeTab === "kanban") renderKanban(document.getElementById("tabKanban"));
    else if (activeTab === "historique") renderHistorique(document.getElementById("tabHistorique"));
    else renderStatistiques(document.getElementById("tabStatistiques"));

    // Une autre page (ex : Matériel) peut demander l'ouverture immédiate d'un formulaire de
    // création de ticket pré-rempli pour un véhicule/matériel précis (req.nature === "controle"
    // pour ouvrir directement un contrôle général plutôt qu'une réparation classique).
    if (App.pendingTicketRequest) {
      var req = App.pendingTicketRequest;
      App.pendingTicketRequest = null;
      if (req.nature === "controle") openControleForm(null, req.id);
      else openTicketForm(null, req);
    }

    // ...ou l'ouverture directe d'un ticket EXISTANT (ex : depuis l'historique des réparations
    // d'un véhicule, page Matériel), par opposition à pendingTicketRequest qui ne sert qu'à
    // pré-remplir la création d'un nouveau ticket.
    if (App.pendingTicketOpenId) {
      var openId = App.pendingTicketOpenId;
      App.pendingTicketOpenId = null;
      var existingTicket = DB.get("ticketsReparation", openId);
      if (existingTicket) {
        if (existingTicket.nature === "controle") openControleForm(existingTicket);
        else openTicketForm(existingTicket, null);
      }
    }

    // ------------------------------------------------------------------
    // KPIs
    // ------------------------------------------------------------------
    function computeKpis() {
      var tickets = DB.list("ticketsReparation");
      var ouverts = tickets.filter(function (t) { return t.statut === "nouveau" || t.statut === "en_cours"; });
      var immobilisants = ouverts.filter(function (t) { return t.immobilise; });

      var end = new Date(); var start = new Date(); start.setDate(end.getDate() - 29);
      var startIso = start.toISOString().slice(0, 10), endIso = end.toISOString().slice(0, 10);
      var coutPeriode = tickets.filter(function (t) { return t.statut === "termine" && t.dateFin && t.dateFin >= startIso && t.dateFin <= endIso; })
        .reduce(function (a, t) { return a + (Number(t.cout) || 0); }, 0);

      var termines = tickets.filter(function (t) { return t.statut === "termine" && t.dateDebut && t.dateFin; });
      var dureeMoyenne = 0;
      if (termines.length) {
        var totalJours = termines.reduce(function (a, t) {
          var d1 = new Date(t.dateDebut), d2 = new Date(t.dateFin);
          return a + Math.max(0, Math.round((d2 - d1) / 86400000));
        }, 0);
        dureeMoyenne = totalJours / termines.length;
      }
      return { ouverts: ouverts.length, immobilisants: immobilisants.length, coutPeriode: coutPeriode, dureeMoyenne: dureeMoyenne, nbTermines: termines.length };
    }

    function renderKpis() {
      var k = computeKpis();
      document.getElementById("kpiRow").innerHTML =
        kpi("wrench", "Tickets ouverts", DB.fmtNum(k.ouverts)) +
        kpi("alert", "Dont immobilisants", DB.fmtNum(k.immobilisants)) +
        kpi("euro", "Coût réparations (30 derniers jours)", DB.fmtEUR(k.coutPeriode)) +
        kpi("clock", "Durée moyenne de réparation", k.nbTermines ? k.dureeMoyenne.toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " j" : "—");
    }

    // ------------------------------------------------------------------
    // Onglet Kanban
    // ------------------------------------------------------------------
    function renderKanban(panel) {
      panel.innerHTML =
        '<div class="form-row" style="margin-top:14px;margin-bottom:16px;align-items:flex-end;">' +
          '<div class="field mb-0"><label>Recherche</label><input type="search" id="kq" placeholder="Matériel, titre…" value="' + LM.escapeHtml(kanbanFilters.q) + '" /></div>' +
          '<div class="field mb-0"><label>Type</label><select id="kType">' +
            '<option value=""' + (kanbanFilters.type === "" ? " selected" : "") + '>Tous types</option>' +
            '<option value="vehicule"' + (kanbanFilters.type === "vehicule" ? " selected" : "") + '>Véhicules</option>' +
            '<option value="materiel"' + (kanbanFilters.type === "materiel" ? " selected" : "") + '>Autre matériel</option>' +
          '</select></div>' +
          '<div class="field mb-0"><label>Nature</label><select id="kNature">' +
            '<option value=""' + (kanbanFilters.nature === "" ? " selected" : "") + '>Tout</option>' +
            '<option value="reparation"' + (kanbanFilters.nature === "reparation" ? " selected" : "") + '>Réparations</option>' +
            '<option value="controle"' + (kanbanFilters.nature === "controle" ? " selected" : "") + '>Contrôles / maintenance</option>' +
          '</select></div>' +
          '<div class="field mb-0"><button class="btn btn-secondary btn-sm" id="btnToggleAnnules">' + (showAnnules ? "Masquer les annulés" : "Afficher les annulés") + '</button></div>' +
          '<div class="field mb-0" style="margin-left:auto;display:flex;gap:8px;">' +
            '<button class="btn btn-secondary" id="btnNewControle" title="Contrôle général effectué sans demande préalable (ex : vérification d\'un vélo)">' + LM.icon("eye") + ' Nouveau contrôle</button>' +
            '<button class="btn btn-primary" id="btnNewTicket">' + LM.icon("plus") + ' Nouveau ticket</button>' +
          '</div>' +
        '</div>' +
        '<div class="kanban-board" id="kanbanBoard"></div>';

      document.getElementById("kq").addEventListener("input", function (e) { kanbanFilters.q = e.target.value; renderBoard(); });
      document.getElementById("kType").addEventListener("change", function (e) { kanbanFilters.type = e.target.value; renderBoard(); });
      document.getElementById("kNature").addEventListener("change", function (e) { kanbanFilters.nature = e.target.value; renderBoard(); });
      document.getElementById("btnToggleAnnules").addEventListener("click", function () { showAnnules = !showAnnules; renderKanban(panel); });
      document.getElementById("btnNewTicket").addEventListener("click", function () { openTicketForm(null, null); });
      document.getElementById("btnNewControle").addEventListener("click", function () { openControleForm(null, null); });

      renderBoard();

      function renderBoard() {
        var board = document.getElementById("kanbanBoard");
        // Les contrôles (nature "controle") ont leur propre colonne, séparée des 3 colonnes de
        // statut de réparation : ils y restent groupés quel que soit leur statut calculé (RAS ou
        // anomalie détectée), pour ne pas se mélanger aux vraies réparations en cours/terminées.
        var colonnes = COLONNES_BASE.slice();
        colonnes.push({ key: "controle", label: "Contrôle", isControle: true, subtitle: "Contrôles / maintenance" });
        if (showAnnules) colonnes.push({ key: "annule", label: "Annulé" });

        var q = DB.normalizeStr(kanbanFilters.q);
        var tickets = DB.list("ticketsReparation").filter(function (t) {
          if (kanbanFilters.type && t.materielType !== kanbanFilters.type) return false;
          if (kanbanFilters.nature && (t.nature || "reparation") !== kanbanFilters.nature) return false;
          if (q) {
            var hay = DB.normalizeStr(t.titre + " " + ticketMaterielCurrentLabel(t));
            if (hay.indexOf(q) === -1) return false;
          }
          return true;
        });

        board.innerHTML = colonnes.map(function (col) {
          var colTickets = (col.isControle ?
            tickets.filter(function (t) { return (t.nature || "reparation") === "controle"; }) :
            tickets.filter(function (t) { return t.statut === col.key && (t.nature || "reparation") !== "controle"; })
          ).sort(function (a, b) { return (b.dateCreation || "").localeCompare(a.dateCreation || ""); });
          return '<div class="kanban-col' + (col.isControle ? " kanban-col-controle" : "") + '">' +
            '<div class="kanban-col-header"><span>' + col.label + (col.subtitle ? '<span class="kanban-col-subtitle">' + col.subtitle + '</span>' : '') + '</span><span class="badge badge-muted">' + colTickets.length + '</span></div>' +
            '<div class="kanban-col-body"' + (col.isControle ? '' : ' data-dropzone="' + col.key + '"') + '>' +
              (colTickets.length ? colTickets.map(cardHtml).join("") : '<div class="kanban-empty">Aucun ticket</div>') +
            '</div>' +
          '</div>';
        }).join("");

        board.querySelectorAll("[data-ticket]").forEach(function (card) {
          card.addEventListener("dragstart", function (e) {
            e.dataTransfer.setData("text/plain", card.getAttribute("data-ticket"));
            e.dataTransfer.effectAllowed = "move";
            card.classList.add("dragging");
          });
          card.addEventListener("dragend", function () { card.classList.remove("dragging"); });
          card.addEventListener("click", function () {
            var tk = DB.get("ticketsReparation", card.getAttribute("data-ticket"));
            if (tk && tk.nature === "controle") openControleForm(tk);
            else openTicketForm(tk, null);
          });
        });

        board.querySelectorAll("[data-dropzone]").forEach(function (zone) {
          zone.addEventListener("dragover", function (e) { e.preventDefault(); zone.classList.add("drag-over"); });
          zone.addEventListener("dragleave", function () { zone.classList.remove("drag-over"); });
          zone.addEventListener("drop", function (e) {
            e.preventDefault();
            zone.classList.remove("drag-over");
            var ticketId = e.dataTransfer.getData("text/plain");
            handleDrop(ticketId, zone.getAttribute("data-dropzone"));
          });
        });
      }

      function handleDrop(ticketId, targetStatut) {
        var t = DB.get("ticketsReparation", ticketId);
        if (!t || t.statut === targetStatut) return;

        if (t.nature === "controle") {
          // Le statut d'un contrôle est déduit automatiquement de l'état des parties inspectées
          // (voir openControleForm) : on rouvre son formulaire pour ajuster la check-list plutôt
          // que de forcer un déplacement brut qui serait aussitôt recalculé au prochain enregistrement.
          openControleForm(t);
          return;
        }
        if (targetStatut === "termine") {
          // Clôturer un ticket nécessite un minimum d'informations sur la réparation :
          // on ouvre le formulaire pré-rempli plutôt que de valider le déplacement à l'aveugle.
          openTicketForm(t, null, { forceStatut: "termine" });
          return;
        }
        if (targetStatut === "annule") {
          LM.confirmDialog("Annuler ce ticket ?", function () {
            var patch = { statut: "annule" };
            if (!t.dateFin) patch.dateFin = DB.todayISO();
            DB.update("ticketsReparation", t.id, patch);
            DB.recalcEtatMateriel(t.materielType, t.materielId);
            DB.logHistorique("Réparations", "modification", "Ticket annulé : " + t.titre);
            LM.toast("Ticket annulé.", "success");
            renderBoard(); renderKpis();
          });
          return;
        }
        var patch = { statut: targetStatut };
        if (targetStatut === "en_cours" && !t.dateDebut) patch.dateDebut = DB.todayISO();
        DB.update("ticketsReparation", t.id, patch);
        DB.recalcEtatMateriel(t.materielType, t.materielId);
        DB.logHistorique("Réparations", "modification", "Ticket déplacé : " + t.titre + " -> " + STATUT_LABELS[targetStatut]);
        LM.toast("Ticket déplacé vers « " + STATUT_LABELS[targetStatut] + " ».", "success");
        renderBoard(); renderKpis();
      }
    }

    function cardHtml(t) {
      var typeIcon = t.materielType === "vehicule" ? "truck" : "box";
      var prio = PRIORITES[t.priorite] || PRIORITES.normale;
      return '<div class="kanban-card" draggable="true" data-ticket="' + t.id + '">' +
        '<div class="kanban-card-top"><span class="kanban-card-type">' + LM.icon(typeIcon) + LM.escapeHtml(ticketMaterielCurrentLabel(t)) + '</span>' +
          '<span class="text-faint text-sm">' + LM.escapeHtml(DB.fmtTicketRef(t.ticketNumber)) + '</span></div>' +
        '<div class="kanban-card-title">' + LM.escapeHtml(t.titre) + '</div>' +
        '<div class="kanban-card-meta">' +
          (t.nature === "controle" ? '<span class="badge ' + (t.statut === "nouveau" ? "badge-danger" : "badge-success") + '">' + (t.statut === "nouveau" ? "Anomalie détectée" : "RAS") + '</span>' : '') +
          '<span class="badge ' + prio.cls + '">' + prio.label + '</span>' +
          (t.immobilise ? '<span class="badge badge-danger">Immobilisé</span>' : '') +
          (t.partieConcernee ? '<span class="chip">' + LM.icon("wrench") + LM.escapeHtml(DB.listeLabel("partiesControle", t.partieConcernee) || "Partie supprimée") + '</span>' : '') +
          (t.reparateur ? '<span class="chip">' + LM.escapeHtml(t.reparateur) + '</span>' : '') +
        '</div>' +
        '<div class="kanban-card-date text-faint text-sm">Créé le ' + DB.fmtDate(t.dateCreation) + '</div>' +
      '</div>';
    }

    // ------------------------------------------------------------------
    // Onglet Historique
    // ------------------------------------------------------------------
    function renderHistorique(panel) {
      panel.innerHTML =
        '<div class="form-row" style="margin-top:14px;margin-bottom:10px;align-items:flex-end;">' +
          '<div class="field mb-0"><label>Recherche</label><input type="search" id="hq" placeholder="Matériel, titre, réparateur…" value="' + LM.escapeHtml(histFilters.q) + '" /></div>' +
          '<div class="field mb-0"><label>Statut</label><select id="hStatut">' +
            '<option value=""' + (histFilters.statut === "" ? " selected" : "") + '>Terminés et annulés</option>' +
            '<option value="termine"' + (histFilters.statut === "termine" ? " selected" : "") + '>Terminés uniquement</option>' +
            '<option value="annule"' + (histFilters.statut === "annule" ? " selected" : "") + '>Annulés uniquement</option>' +
          '</select></div>' +
          '<div class="field mb-0"><label>Nature</label><select id="hNature">' +
            '<option value=""' + (histFilters.nature === "" ? " selected" : "") + '>Tout</option>' +
            '<option value="reparation"' + (histFilters.nature === "reparation" ? " selected" : "") + '>Réparations</option>' +
            '<option value="controle"' + (histFilters.nature === "controle" ? " selected" : "") + '>Contrôles / maintenance</option>' +
          '</select></div>' +
          '<div class="field mb-0"><label>Période</label><select id="hPeriode">' +
            '<option value="tout"' + (histFilters.periode === "tout" ? " selected" : "") + '>Toute la période</option>' +
            '<option value="30j"' + (histFilters.periode === "30j" ? " selected" : "") + '>30 derniers jours</option>' +
            '<option value="90j"' + (histFilters.periode === "90j" ? " selected" : "") + '>90 derniers jours</option>' +
          '</select></div>' +
        '</div>' +
        '<p class="text-sm" id="histSummary"></p>' +
        '<div class="table-wrap"><table><thead><tr>' +
          '<th>Réf.</th><th>Nature</th><th>Matériel</th><th>Titre</th><th>Priorité</th><th>Réparateur</th><th>Créé le</th><th>Terminé le</th><th class="num">Durée (j)</th><th class="num">Coût</th><th>Statut</th><th></th>' +
        '</tr></thead><tbody id="histBody"></tbody></table></div>';

      document.getElementById("hq").addEventListener("input", function (e) { histFilters.q = e.target.value; renderRows(); });
      document.getElementById("hStatut").addEventListener("change", function (e) { histFilters.statut = e.target.value; renderRows(); });
      document.getElementById("hNature").addEventListener("change", function (e) { histFilters.nature = e.target.value; renderRows(); });
      document.getElementById("hPeriode").addEventListener("change", function (e) { histFilters.periode = e.target.value; renderRows(); });

      renderRows();

      function renderRows() {
        var q = DB.normalizeStr(histFilters.q);
        var rows = DB.list("ticketsReparation").filter(function (t) {
          if (t.statut !== "termine" && t.statut !== "annule") return false;
          if (histFilters.statut && t.statut !== histFilters.statut) return false;
          if (histFilters.nature && (t.nature || "reparation") !== histFilters.nature) return false;
          if (q) {
            var hay = DB.normalizeStr(t.titre + " " + ticketMaterielCurrentLabel(t) + " " + (t.reparateur || ""));
            if (hay.indexOf(q) === -1) return false;
          }
          if (histFilters.periode !== "tout") {
            var days = histFilters.periode === "30j" ? 29 : 89;
            var limit = new Date(); limit.setDate(limit.getDate() - days);
            var limitIso = limit.toISOString().slice(0, 10);
            var refDate = t.dateFin || t.dateCreation;
            if (refDate < limitIso) return false;
          }
          return true;
        }).sort(function (a, b) { return (b.dateFin || b.dateCreation || "").localeCompare(a.dateFin || a.dateCreation || ""); });

        var totalCout = rows.reduce(function (a, t) { return a + (Number(t.cout) || 0); }, 0);
        document.getElementById("histSummary").textContent = rows.length + " ticket(s) — coût total : " + DB.fmtEUR(totalCout);

        var tbody = document.getElementById("histBody");
        if (!rows.length) { tbody.innerHTML = '<tr class="empty-row"><td colspan="12">Aucun ticket ne correspond aux filtres.</td></tr>'; return; }

        tbody.innerHTML = rows.map(function (t) {
          var prio = PRIORITES[t.priorite] || PRIORITES.normale;
          var duree = (t.dateDebut && t.dateFin) ? Math.max(0, Math.round((new Date(t.dateFin) - new Date(t.dateDebut)) / 86400000)) : null;
          var statutCls = t.statut === "termine" ? "badge-success" : "badge-muted";
          var nature = t.nature || "reparation";
          return '<tr>' +
            '<td class="text-sm text-faint">' + LM.escapeHtml(DB.fmtTicketRef(t.ticketNumber)) + '</td>' +
            '<td><span class="badge ' + NATURE_CLS[nature] + '">' + NATURE_LABELS[nature] + '</span></td>' +
            '<td><strong>' + LM.escapeHtml(ticketMaterielCurrentLabel(t)) + '</strong><div class="text-faint text-sm">' + LM.escapeHtml(t.titre) + '</div></td>' +
            '<td class="text-sm">' + LM.escapeHtml(t.titre) + '</td>' +
            '<td><span class="badge ' + prio.cls + '">' + prio.label + '</span></td>' +
            '<td>' + (t.reparateur ? LM.escapeHtml(t.reparateur) : '<span class="text-faint">—</span>') + '</td>' +
            '<td class="text-sm">' + DB.fmtDate(t.dateCreation) + '</td>' +
            '<td class="text-sm">' + (t.dateFin ? DB.fmtDate(t.dateFin) : '<span class="text-faint">—</span>') + '</td>' +
            '<td class="num">' + (duree !== null ? duree : '—') + '</td>' +
            '<td class="num">' + (t.cout !== "" && t.cout !== undefined && t.cout !== null ? DB.fmtEUR(t.cout) : '—') + '</td>' +
            '<td><span class="badge ' + statutCls + '">' + STATUT_LABELS[t.statut] + '</span></td>' +
            '<td class="actions">' +
              '<button class="btn btn-ghost btn-sm" data-reopen="' + t.id + '">Rouvrir</button> ' +
              '<button class="btn btn-ghost btn-sm btn-icon" data-view="' + t.id + '" title="Voir le détail">' + LM.icon("edit") + '</button>' +
            '</td>' +
          '</tr>';
        }).join("");

        tbody.querySelectorAll("[data-view]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var tk = DB.get("ticketsReparation", btn.getAttribute("data-view"));
            if (tk.nature === "controle") openControleForm(tk);
            else openTicketForm(tk, null);
          });
        });
        tbody.querySelectorAll("[data-reopen]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var id = btn.getAttribute("data-reopen");
            var t = DB.get("ticketsReparation", id);
            if (t.nature === "controle") { openControleForm(t); return; }
            DB.update("ticketsReparation", id, { statut: "en_cours" });
            DB.recalcEtatMateriel(t.materielType, t.materielId);
            DB.logHistorique("Réparations", "modification", "Ticket rouvert : " + t.titre);
            LM.toast("Ticket rouvert.", "success");
            renderRows(); renderKpis();
          });
        });
      }
    }

    // ------------------------------------------------------------------
    // Onglet Statistiques : quelles parties tombent le plus souvent en panne, quels véhicules/
    // matériels et réparateurs reviennent le plus souvent, et l'évolution dans le temps. Combine
    // les réparations classiques (champ "Partie concernée") et les anomalies détectées lors des
    // contrôles (check-list), pour donner une vue complète sans ressaisie.
    // ------------------------------------------------------------------
    function renderStatistiques(panel) {
      panel.innerHTML =
        '<div class="form-row" style="margin-top:14px;margin-bottom:6px;align-items:flex-end;">' +
          '<div class="field mb-0"><label>Période</label><select id="stPeriode">' +
            '<option value="30j"' + (statsFilters.periode === "30j" ? " selected" : "") + '>30 derniers jours</option>' +
            '<option value="90j"' + (statsFilters.periode === "90j" ? " selected" : "") + '>90 derniers jours</option>' +
            '<option value="12m"' + (statsFilters.periode === "12m" ? " selected" : "") + '>12 derniers mois</option>' +
            '<option value="tout"' + (statsFilters.periode === "tout" ? " selected" : "") + '>Toute la période</option>' +
            '<option value="custom"' + (statsFilters.periode === "custom" ? " selected" : "") + '>Période personnalisée</option>' +
          '</select></div>' +
          '<div class="field mb-0" id="stCustomStartWrap" style="' + (statsFilters.periode === "custom" ? "" : "display:none;") + '"><label>Du</label><input type="date" id="stCustomStart" value="' + statsFilters.start + '" /></div>' +
          '<div class="field mb-0" id="stCustomEndWrap" style="' + (statsFilters.periode === "custom" ? "" : "display:none;") + '"><label>Au</label><input type="date" id="stCustomEnd" value="' + statsFilters.end + '" /></div>' +
          '<div class="field mb-0"><label>Type de matériel</label><select id="stType">' +
            '<option value=""' + (statsFilters.type === "" ? " selected" : "") + '>Tous types</option>' +
            '<option value="vehicule"' + (statsFilters.type === "vehicule" ? " selected" : "") + '>Véhicules</option>' +
            '<option value="materiel"' + (statsFilters.type === "materiel" ? " selected" : "") + '>Autre matériel</option>' +
          '</select></div>' +
        '</div>' +
        '<div class="grid grid-4" id="statsKpiRow" style="margin-bottom:22px;"></div>' +
        '<div class="grid grid-2">' +
          '<div class="card"><h3>Parties les plus sujettes à réparation</h3><p class="text-sm">Réparations avec une « Partie concernée » renseignée, et anomalies détectées lors des contrôles. Liste des parties personnalisable depuis Annexes.</p><div id="stChartParts" style="margin-top:10px;"></div></div>' +
          '<div class="card"><h3>Réparations par priorité</h3><p class="text-sm">Sur la période sélectionnée ci-dessus.</p><div id="stChartPrio" style="margin-top:10px;"></div></div>' +
        '</div>' +
        '<div class="card"><h3>Évolution mensuelle</h3><p class="text-sm">Tickets créés par mois, sur les 12 derniers mois (indépendant du filtre de période ci-dessus).</p><div id="stChartEvo" style="margin-top:10px;"></div></div>' +
        '<div class="grid grid-2">' +
          '<div class="card"><h3>Véhicules / matériel les plus sujets aux pannes</h3><p class="text-sm">Nombre de réparations sur la période sélectionnée.</p><div class="table-wrap" style="margin-top:10px;"><table><thead><tr><th>Élément</th><th class="num">Réparations</th><th class="num">Coût total</th><th>Dernière intervention</th></tr></thead><tbody id="stTopMateriel"></tbody></table></div></div>' +
          '<div class="card"><h3>Réparateurs les plus sollicités</h3><p class="text-sm">Réparations et contrôles confondus, sur la période sélectionnée.</p><div class="table-wrap" style="margin-top:10px;"><table><thead><tr><th>Réparateur</th><th class="num">Interventions</th><th class="num">Coût total</th></tr></thead><tbody id="stTopReparateurs"></tbody></table></div></div>' +
        '</div>';

      document.getElementById("stPeriode").addEventListener("change", function (e) {
        statsFilters.periode = e.target.value;
        renderStatistiques(panel);
      });
      var stCustomStart = document.getElementById("stCustomStart");
      if (stCustomStart) stCustomStart.addEventListener("change", function (e) { statsFilters.start = e.target.value; refreshAll(); });
      var stCustomEnd = document.getElementById("stCustomEnd");
      if (stCustomEnd) stCustomEnd.addEventListener("change", function (e) { statsFilters.end = e.target.value; refreshAll(); });
      document.getElementById("stType").addEventListener("change", function (e) { statsFilters.type = e.target.value; refreshAll(); });

      refreshAll();

      function statsRange() {
        if (statsFilters.periode === "tout") return { start: null, end: null };
        if (statsFilters.periode === "custom") return { start: statsFilters.start || null, end: statsFilters.end || null };
        var days = statsFilters.periode === "30j" ? 29 : (statsFilters.periode === "90j" ? 89 : 364);
        var limit = new Date(); limit.setDate(limit.getDate() - days);
        return { start: limit.toISOString().slice(0, 10), end: null };
      }

      function inRange(t, range) {
        var d = t.dateCreation || "";
        if (range.start && d < range.start) return false;
        if (range.end && d > range.end) return false;
        return true;
      }

      function filteredTickets() {
        var range = statsRange();
        return DB.list("ticketsReparation").filter(function (t) {
          if (statsFilters.type && t.materielType !== statsFilters.type) return false;
          return inRange(t, range);
        });
      }

      function refreshAll() {
        var all = filteredTickets();
        var reparationRows = all.filter(function (t) { return (t.nature || "reparation") === "reparation" && t.statut !== "annule"; });
        var controleRows = all.filter(function (t) { return t.nature === "controle"; });

        renderStatsKpis(reparationRows);
        renderChartParts(reparationRows, controleRows);
        renderChartPrio(reparationRows);
        renderChartEvo();
        renderTopMateriel(reparationRows);
        renderTopReparateurs(all.filter(function (t) { return t.statut !== "annule"; }));
      }

      function renderStatsKpis(rows) {
        var nb = rows.length;
        var coutTotal = rows.reduce(function (a, t) { return a + (Number(t.cout) || 0); }, 0);
        var coutMoyen = nb ? coutTotal / nb : 0;
        var termines = rows.filter(function (t) { return t.dateDebut && t.dateFin; });
        var dureeMoyenne = 0;
        if (termines.length) {
          var totalJours = termines.reduce(function (a, t) {
            return a + Math.max(0, Math.round((new Date(t.dateFin) - new Date(t.dateDebut)) / 86400000));
          }, 0);
          dureeMoyenne = totalJours / termines.length;
        }
        document.getElementById("statsKpiRow").innerHTML =
          kpi("wrench", "Réparations sur la période", DB.fmtNum(nb)) +
          kpi("euro", "Coût total", DB.fmtEUR(coutTotal)) +
          kpi("euro", "Coût moyen par réparation", nb ? DB.fmtEUR(coutMoyen) : "—") +
          kpi("clock", "Durée moyenne de résolution", termines.length ? dureeMoyenne.toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " j" : "—");
      }

      function partLabel(key) {
        return DB.listeLabel("partiesControle", key) || "Partie supprimée";
      }

      function renderChartParts(reparationRows, controleRows) {
        var counts = {};
        reparationRows.forEach(function (t) {
          if (!t.partieConcernee) return;
          if (!counts[t.partieConcernee]) counts[t.partieConcernee] = { reparations: 0, anomalies: 0 };
          counts[t.partieConcernee].reparations++;
        });
        controleRows.forEach(function (t) {
          (t.checklist || []).forEach(function (c) {
            if (c.etat !== "probleme") return;
            if (!counts[c.key]) counts[c.key] = { reparations: 0, anomalies: 0 };
            counts[c.key].anomalies++;
          });
        });
        var keys = Object.keys(counts).sort(function (a, b) {
          return (counts[b].reparations + counts[b].anomalies) - (counts[a].reparations + counts[a].anomalies);
        }).slice(0, 8);

        var container = document.getElementById("stChartParts");
        if (!keys.length) {
          container.innerHTML = '<div class="empty-state">' + LM.icon("empty") + '<h3>Aucune donnée</h3><p>Renseignez la « Partie concernée » sur vos tickets de réparation, ou effectuez des contrôles, pour voir apparaître ce graphique.</p></div>';
          return;
        }
        LMCharts.barChart(container, {
          labels: keys.map(partLabel),
          series: [
            { name: "Réparations", data: keys.map(function (k) { return counts[k].reparations; }) },
            { name: "Anomalies détectées en contrôle", data: keys.map(function (k) { return counts[k].anomalies; }) }
          ],
          height: 260
        });
      }

      function renderChartPrio(rows) {
        var container = document.getElementById("stChartPrio");
        var counts = {};
        rows.forEach(function (t) { var k = t.priorite || "normale"; counts[k] = (counts[k] || 0) + 1; });
        var data = Object.keys(PRIORITES).map(function (k) { return { label: PRIORITES[k].label, value: counts[k] || 0 }; });
        LMCharts.donutChart(container, { data: data, height: 220 });
      }

      function renderChartEvo() {
        var container = document.getElementById("stChartEvo");
        var months = [];
        var now = new Date();
        for (var i = 11; i >= 0; i--) {
          var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
          var mm = d.getMonth() + 1;
          months.push({ key: d.getFullYear() + "-" + (mm < 10 ? "0" : "") + mm, label: d.toLocaleDateString("fr-FR", { month: "short", year: "2-digit" }) });
        }
        var allTickets = DB.list("ticketsReparation").filter(function (t) { return !statsFilters.type || t.materielType === statsFilters.type; });
        var reparCounts = months.map(function (m) {
          return allTickets.filter(function (t) {
            return (t.nature || "reparation") === "reparation" && t.statut !== "annule" && (t.dateCreation || "").indexOf(m.key) === 0;
          }).length;
        });
        var controleAnomalies = months.map(function (m) {
          var count = 0;
          allTickets.filter(function (t) { return t.nature === "controle" && (t.dateCreation || "").indexOf(m.key) === 0; }).forEach(function (t) {
            (t.checklist || []).forEach(function (c) { if (c.etat === "probleme") count++; });
          });
          return count;
        });
        LMCharts.lineChart(container, {
          labels: months.map(function (m) { return m.label; }),
          series: [
            { name: "Réparations créées", data: reparCounts },
            { name: "Anomalies détectées en contrôle", data: controleAnomalies }
          ],
          height: 260
        });
      }

      function renderTopMateriel(rows) {
        var groups = {};
        rows.forEach(function (t) {
          var gid = t.materielType + "|" + t.materielId;
          if (!groups[gid]) groups[gid] = { ticket: t, count: 0, cout: 0, last: "" };
          groups[gid].count++;
          groups[gid].cout += Number(t.cout) || 0;
          if ((t.dateCreation || "") > groups[gid].last) { groups[gid].last = t.dateCreation || ""; groups[gid].ticket = t; }
        });
        var list = Object.keys(groups).map(function (k) { return groups[k]; }).sort(function (a, b) { return b.count - a.count; }).slice(0, 8);
        var tbody = document.getElementById("stTopMateriel");
        if (!list.length) { tbody.innerHTML = '<tr class="empty-row"><td colspan="4">Aucune donnée sur la période.</td></tr>'; return; }
        tbody.innerHTML = list.map(function (g) {
          return '<tr>' +
            '<td>' + LM.escapeHtml(ticketMaterielCurrentLabel(g.ticket)) + '</td>' +
            '<td class="num">' + DB.fmtNum(g.count) + '</td>' +
            '<td class="num">' + DB.fmtEUR(g.cout) + '</td>' +
            '<td class="text-sm">' + DB.fmtDate(g.last) + '</td>' +
          '</tr>';
        }).join("");
      }

      function renderTopReparateurs(rows) {
        var groups = {};
        rows.forEach(function (t) {
          var name = (t.reparateur || "").toString().trim();
          if (!name) return;
          if (!groups[name]) groups[name] = { count: 0, cout: 0 };
          groups[name].count++;
          groups[name].cout += Number(t.cout) || 0;
        });
        var names = Object.keys(groups).sort(function (a, b) { return groups[b].count - groups[a].count; }).slice(0, 8);
        var tbody = document.getElementById("stTopReparateurs");
        if (!names.length) { tbody.innerHTML = '<tr class="empty-row"><td colspan="3">Aucun réparateur renseigné sur la période.</td></tr>'; return; }
        tbody.innerHTML = names.map(function (name) {
          return '<tr>' +
            '<td>' + LM.escapeHtml(name) + '</td>' +
            '<td class="num">' + DB.fmtNum(groups[name].count) + '</td>' +
            '<td class="num">' + DB.fmtEUR(groups[name].cout) + '</td>' +
          '</tr>';
        }).join("");
      }
    }

    // ------------------------------------------------------------------
    // Formulaire de ticket (création / édition / clôture)
    // ------------------------------------------------------------------
    function itemOptions(type, selectedId) {
      var list = type === "vehicule" ? DB.list("vehicules") : DB.list("materiels");
      var opts = '<option value="">Sélectionner…</option>' + list.map(function (it) {
        var label = type === "vehicule" ? it.plaque : it.nom;
        var stateLabel = type === "vehicule" ? (VEH_STATUT_LABELS[it.statut] || it.statut) : (MAT_ETAT_LABELS[it.etat] || it.etat);
        return '<option value="' + it.id + '"' + (it.id === selectedId ? " selected" : "") + '>' + LM.escapeHtml(label) + ' — ' + stateLabel + '</option>';
      }).join("");
      return opts;
    }

    // Nombre de tickets encore ouverts (à réparer / en réparation) sur un élément : sert à
    // prévenir d'un éventuel doublon lors de la création d'un nouveau ticket.
    function ticketOpenCount(type, id) {
      return DB.list("ticketsReparation").filter(function (tk) {
        return tk.materielType === type && tk.materielId === id && (tk.statut === "nouveau" || tk.statut === "en_cours") && (tk.nature || "reparation") === "reparation";
      }).length;
    }

    // Cartes de sélection du matériel (colonne de gauche du pop-up « Nouveau ticket »).
    function ticketItemsHtml(type, selectedId, query) {
      var isVeh = type === "vehicule";
      var q = DB.normalizeStr(query || "");
      var items = (isVeh ? DB.list("vehicules") : DB.list("materiels")).map(function (it) {
        var label = isVeh ? it.plaque : it.nom;
        var sub = [isVeh ? DB.listeLabel("typesVehicule", it.type) : DB.listeLabel("categoriesMateriel", it.categorie), DB.entrepotNom(it.entrepotId)].filter(Boolean).join(" · ");
        return { it: it, label: label || "", sub: sub };
      }).filter(function (x) {
        return !q || DB.normalizeStr(x.label + " " + x.sub).indexOf(q) !== -1;
      }).sort(function (a, b) { return a.label.localeCompare(b.label, "fr"); });

      if (!items.length) {
        return '<div class="ticket-item-empty">' + (q ? "Aucun résultat pour cette recherche." : (isVeh ? "Aucun véhicule enregistré." : "Aucun matériel enregistré.")) + '</div>';
      }
      var okCls = { service: "badge-success", maintenance: "badge-warning", hors_service: "badge-danger", bon: "badge-success", moyen: "badge-warning", a_remplacer: "badge-danger" };
      return items.map(function (x) {
        var it = x.it;
        var state = isVeh ? it.statut : it.etat;
        var stateLabel = isVeh ? (VEH_STATUT_LABELS[state] || state) : (MAT_ETAT_LABELS[state] || state);
        var nOpen = ticketOpenCount(type, it.id);
        return '<button type="button" class="ticket-item' + (it.id === selectedId ? " selected" : "") + '" data-titem="' + it.id + '" aria-pressed="' + (it.id === selectedId ? "true" : "false") + '">' +
          '<span class="ticket-item-icon">' + LM.icon(isVeh ? "truck" : "box") + '</span>' +
          '<span class="ticket-item-body">' +
            '<span class="ticket-item-label">' + LM.escapeHtml(x.label) + '</span>' +
            '<span class="ticket-item-sub">' + LM.escapeHtml(x.sub || "—") + '</span>' +
          '</span>' +
          '<span class="ticket-item-badges">' +
            '<span class="badge ' + (okCls[state] || "badge-muted") + '">' + LM.escapeHtml(stateLabel || "—") + '</span>' +
            (nOpen ? '<span class="badge badge-warning" title="Tickets déjà ouverts sur cet élément">' + nOpen + ' ouvert' + (nOpen > 1 ? "s" : "") + '</span>' : '') +
          '</span>' +
        '</button>';
      }).join("");
    }

    function openTicketForm(existing, presetItem, opts) {
      opts = opts || {};
      var isEdit = !!existing;
      var t = existing || {
        materielType: presetItem ? presetItem.type : "vehicule",
        materielId: presetItem ? presetItem.id : "",
        titre: "", description: "", priorite: "normale", immobilise: false, statut: "nouveau",
        creePar: "", dateCreation: DB.todayISO(),
        reparateur: "", dateDebut: "", dateFin: "", cout: "", compteRendu: "", partieConcernee: ""
      };
      var forcedStatut = opts.forceStatut;
      var initialStatut = forcedStatut || t.statut;
      var initialDateFin = (forcedStatut === "termine" && !t.dateFin) ? DB.todayISO() : t.dateFin;

      // Onglet forcé : quand on clôture un ticket (glisser-déposer vers "Réparé"), on ouvre
      // directement sur l'onglet Suivi puisque c'est là que se trouvent les champs à compléter.
      var initialTicketTab = forcedStatut === "termine" ? "suivi" : "details";

      // Champs de détail partagés entre l'édition (onglet « Détails ») et la création (colonne
      // de droite du pop-up « Nouveau ticket »).
      var detailFieldsHtml =
      field("Titre *", "titre", t.titre, "text", true, "ex : Frein arrière à réviser") +
          '<div class="field"><label>Description</label><textarea name="description">' + LM.escapeHtml(t.description || "") + '</textarea></div>' +
          '<div class="field"><label>Partie concernée</label><select name="partieConcernee">' +
            '<option value="">Non renseignée</option>' +
            DB.listeItems("partiesControle").map(function (p) { return '<option value="' + p.key + '"' + (p.key === t.partieConcernee ? " selected" : "") + '>' + LM.escapeHtml(p.label) + '</option>'; }).join("") +
            '</select><div class="hint">Alimente l\'onglet Statistiques : quelle partie tombe le plus souvent en panne. Liste personnalisable depuis Annexes.</div></div>' +
          '<div class="form-row">' +
            '<div class="field"><label>Priorité</label><select name="priorite">' +
              Object.keys(PRIORITES).map(function (k) { return '<option value="' + k + '"' + (k === t.priorite ? " selected" : "") + '>' + PRIORITES[k].label + '</option>'; }).join("") +
            '</select></div>' +
            '<div class="field"><label>Statut</label><select name="statut">' +
              Object.keys(STATUT_LABELS).map(function (k) { return '<option value="' + k + '"' + (k === initialStatut ? " selected" : "") + '>' + STATUT_LABELS[k] + '</option>'; }).join("") +
            '</select></div>' +
          '</div>' +
          '<div class="checkbox-row" style="margin-bottom:14px;">' +
            '<input type="checkbox" name="immobilise" id="ticketImmobilise"' + (t.immobilise ? " checked" : "") + ' />' +
            '<label for="ticketImmobilise" style="margin:0;">Immobilise le véhicule / rend le matériel indisponible (panne bloquante)</label>' +
          '</div>' +
          '<div class="form-row">' +
            field("Créé par", "creePar", t.creePar, "text") +
            field("Date de création", "dateCreation", t.dateCreation, "date") +
          '</div>';

      // Nouveau ticket : pop-up scindé en deux — à gauche le matériel et l'élément concerné
      // (sélecteur en cartes avec recherche), à droite les informations du ticket. Pas d'onglet
      // « Suivi de la réparation » à la création : il n'apparaît qu'en ouvrant un ticket existant.
      var newTicketBodyHtml =
        '<form id="ticketForm">' +
          '<input type="hidden" name="materielType" id="ticketType" value="' + LM.escapeHtml(t.materielType) + '" />' +
          '<input type="hidden" name="materielId" id="ticketItem" value="' + LM.escapeHtml(t.materielId || "") + '" />' +
          '<div class="ticket-split">' +
            '<aside class="ticket-side">' +
              '<div class="ticket-pane-title"><span class="ticket-step">1</span><div><strong>Matériel concerné</strong><span class="ticket-pane-sub">Choisissez le type, puis l\'élément en panne.</span></div></div>' +
              '<div class="ticket-seg" role="tablist">' +
                '<button type="button" class="ticket-seg-btn" data-ttype="vehicule">' + LM.icon("truck") + ' Véhicules <span class="ticket-seg-n" id="ticketCountVeh"></span></button>' +
                '<button type="button" class="ticket-seg-btn" data-ttype="materiel">' + LM.icon("box") + ' Autre matériel <span class="ticket-seg-n" id="ticketCountMat"></span></button>' +
              '</div>' +
              '<input type="search" id="ticketItemSearch" class="ticket-search" placeholder="Rechercher un élément…" autocomplete="off" />' +
              '<div class="ticket-item-list" id="ticketItemList"></div>' +
            '</aside>' +
            '<section class="ticket-main">' +
              '<div class="ticket-pane-title"><span class="ticket-step">2</span><div><strong>Informations du ticket</strong><span class="ticket-pane-sub">Décrivez le problème pour le suivre dans le Kanban.</span></div></div>' +
              '<div class="ticket-recap" id="ticketRecap"></div>' +
              detailFieldsHtml +
            '</section>' +
          '</div>' +
        '</form>';

      var refSuffix = isEdit ? " (" + DB.fmtTicketRef(t.ticketNumber) + ")" : "";
      LM.openModal({
        title: forcedStatut === "termine" ? "Clôturer le ticket — " + LM.escapeHtml(t.titre || "") + refSuffix : (isEdit ? "Modifier le ticket" + refSuffix : "Nouveau ticket de réparation"),
        wide: true,
        bodyHtml: !isEdit ? newTicketBodyHtml :
          '<div class="tabs">' +
            '<button type="button" class="tab-btn' + (initialTicketTab === "details" ? " active" : "") + '" data-ttab="details">Détails</button>' +
            '<button type="button" class="tab-btn' + (initialTicketTab === "suivi" ? " active" : "") + '" data-ttab="suivi">Suivi de la réparation</button>' +
          '</div>' +
          '<form id="ticketForm">' +
            '<div class="tab-panel' + (initialTicketTab === "details" ? " active" : "") + '" data-tpanel="details">' +
              '<p class="text-sm"><strong>Matériel concerné :</strong> ' + LM.escapeHtml(ticketMaterielCurrentLabel(t)) + ' <span class="text-faint">(non modifiable)</span>' +
                ' &nbsp;·&nbsp; <strong>Référence :</strong> <span class="badge badge-muted">' + LM.escapeHtml(DB.fmtTicketRef(t.ticketNumber)) + '</span></p>' +
              detailFieldsHtml +
            '</div>' +
            '<div class="tab-panel' + (initialTicketTab === "suivi" ? " active" : "") + '" data-tpanel="suivi">' +
              '<div class="form-row">' +
                field("Réparateur", "reparateur", t.reparateur, "text", false, "Nom du réparateur ou de l'atelier") +
                field("Date de début", "dateDebut", t.dateDebut, "date") +
              '</div>' +
              '<div class="form-row">' +
                field("Date de fin", "dateFin", initialDateFin, "date") +
                field("Coût (€)", "cout", t.cout, "number") +
              '</div>' +
              '<div class="field"><label>Compte-rendu de réparation</label><textarea name="compteRendu">' + LM.escapeHtml(t.compteRendu || "") + '</textarea></div>' +
            '</div>' +
          '</form>',
        footerHtml:
          '<button class="btn btn-secondary" id="cancelBtn">Annuler</button>' +
          (isEdit ? '<button class="btn btn-danger" id="deleteBtn">Supprimer ce ticket</button>' : '') +
          '<button class="btn btn-primary" id="saveBtn">' + (forcedStatut === "termine" ? "Clôturer le ticket" : (isEdit ? "Enregistrer" : "Créer le ticket")) + '</button>',
        onMount: function (modal) {
          modal.querySelectorAll("[data-ttab]").forEach(function (tabBtn) {
            tabBtn.addEventListener("click", function () {
              var key = tabBtn.getAttribute("data-ttab");
              modal.querySelectorAll("[data-ttab]").forEach(function (b) { b.classList.toggle("active", b === tabBtn); });
              modal.querySelectorAll("[data-tpanel]").forEach(function (p) { p.classList.toggle("active", p.getAttribute("data-tpanel") === key); });
            });
          });
          if (!isEdit) {
            modal.classList.add("modal-split");
            var curType = t.materielType, curId = t.materielId || "", curQ = "";
            var typeInput = modal.querySelector("#ticketType");
            var idInput = modal.querySelector("#ticketItem");
            var listEl = modal.querySelector("#ticketItemList");
            var recapEl = modal.querySelector("#ticketRecap");
            modal.querySelector("#ticketCountVeh").textContent = DB.list("vehicules").length;
            modal.querySelector("#ticketCountMat").textContent = DB.list("materiels").length;

            var paintRecap = function () {
              var it = curId ? (curType === "vehicule" ? DB.get("vehicules", curId) : DB.get("materiels", curId)) : null;
              if (!it) {
                recapEl.className = "ticket-recap ticket-recap-empty";
                recapEl.innerHTML = LM.icon("alert") + '<span>Sélectionnez d\'abord le matériel concerné dans la colonne de gauche.</span>';
                return;
              }
              var nOpen = ticketOpenCount(curType, curId);
              recapEl.className = "ticket-recap" + (nOpen ? " ticket-recap-warn" : " ticket-recap-ok");
              recapEl.innerHTML = LM.icon(nOpen ? "alert" : "check") +
                '<span><strong>' + LM.escapeHtml(curType === "vehicule" ? it.plaque : it.nom) + '</strong> — ' + (nOpen ?
                  nOpen + ' ticket' + (nOpen > 1 ? 's' : '') + ' déjà ouvert' + (nOpen > 1 ? 's' : '') + ' sur cet élément : vérifiez qu\'il ne s\'agit pas d\'un doublon.' :
                  'aucun ticket ouvert pour le moment.') + '</span>';
            };
            var paintList = function () {
              listEl.innerHTML = ticketItemsHtml(curType, curId, curQ);
              listEl.querySelectorAll("[data-titem]").forEach(function (btn) {
                btn.addEventListener("click", function () {
                  curId = btn.getAttribute("data-titem");
                  idInput.value = curId;
                  paintList();
                  paintRecap();
                });
              });
              var selEl = listEl.querySelector(".selected");
              if (selEl && selEl.scrollIntoView) selEl.scrollIntoView({ block: "nearest" });
            };
            var paintType = function () {
              modal.querySelectorAll("[data-ttype]").forEach(function (b) { b.classList.toggle("active", b.getAttribute("data-ttype") === curType); });
            };
            modal.querySelectorAll("[data-ttype]").forEach(function (b) {
              b.addEventListener("click", function () {
                var nt = b.getAttribute("data-ttype");
                if (nt === curType) return;
                curType = nt; curId = "";
                typeInput.value = curType; idInput.value = "";
                paintType(); paintList(); paintRecap();
              });
            });
            modal.querySelector("#ticketItemSearch").addEventListener("input", function (e) { curQ = e.target.value; paintList(); });
            paintType(); paintList(); paintRecap();
          }
          modal.querySelector("#cancelBtn").addEventListener("click", LM.closeModal);
          if (isEdit) {
            modal.querySelector("#deleteBtn").addEventListener("click", function () {
              LM.confirmDialog("Supprimer définitivement ce ticket ?", function () {
                DB.remove("ticketsReparation", t.id);
                DB.recalcEtatMateriel(t.materielType, t.materielId);
                DB.logHistorique("Réparations", "suppression", "Suppression ticket : " + t.titre);
                LM.toast("Ticket supprimé.", "success");
                LM.closeModal();
                render(content);
              });
            });
          }
          modal.querySelector("#saveBtn").addEventListener("click", function () {
            var form = modal.querySelector("#ticketForm");
            var fd = new FormData(form);
            var titre = (fd.get("titre") || "").toString().trim();
            var materielType = isEdit ? t.materielType : fd.get("materielType");
            var materielId = isEdit ? t.materielId : (fd.get("materielId") || "");
            if (!titre) { LM.toast("Le titre est obligatoire.", "danger"); return; }
            if (!isEdit && !materielId) { LM.toast("Merci de sélectionner le véhicule ou le matériel concerné.", "danger"); return; }
            var coutRaw = (fd.get("cout") || "").toString().trim();
            var payload = {
              materielType: materielType, materielId: materielId,
              materielLabel: DB.materielLabel(materielType, materielId) || (isEdit ? t.materielLabel : ""),
              titre: titre,
              description: (fd.get("description") || "").toString().trim(),
              priorite: fd.get("priorite"),
              statut: fd.get("statut"),
              immobilise: fd.get("immobilise") === "on",
              creePar: (fd.get("creePar") || "").toString().trim(),
              dateCreation: fd.get("dateCreation") || DB.todayISO(),
              reparateur: (fd.get("reparateur") || "").toString().trim(),
              dateDebut: fd.get("dateDebut") || "",
              dateFin: fd.get("dateFin") || "",
              cout: coutRaw === "" ? "" : (Number(coutRaw) || 0),
              compteRendu: (fd.get("compteRendu") || "").toString().trim(),
              partieConcernee: fd.get("partieConcernee") || ""
            };
            // Résout la clé de la partie concernée en libellé lisible pour le journal d'activité
            // (summarizeFieldChanges compare les valeurs brutes, mais un libellé se lit mieux qu'une clé).
            var partieLabelPour = function (v) { return v ? (DB.listeLabel("partiesControle", v) || v) : ""; };
            var payloadPourLog = Object.assign({}, payload, { partieConcernee: partieLabelPour(payload.partieConcernee) });
            var beforePourLog = isEdit ? Object.assign({}, t, { partieConcernee: partieLabelPour(t.partieConcernee) }) : null;
            if (isEdit) {
              DB.update("ticketsReparation", t.id, payload);
              var changes = DB.summarizeFieldChanges(beforePourLog, payloadPourLog, { titre: "Titre", priorite: "Priorité", statut: "Statut", reparateur: "Réparateur", cout: "Coût", partieConcernee: "Partie concernée" });
              DB.logHistorique("Réparations", "modification", "Modification ticket : " + titre + (changes ? " -> " + changes : ""));
            } else {
              payload.ticketNumber = DB.nextTicketNumber();
              DB.add("ticketsReparation", payload);
              DB.logHistorique("Réparations", "ajout", "Ajout ticket : " + titre + (payload.partieConcernee ? " (" + partieLabelPour(payload.partieConcernee) + ")" : ""));
            }
            DB.recalcEtatMateriel(materielType, materielId);

            var etatMsg = materielType === "vehicule" ?
              (VEH_STATUT_LABELS[(DB.get("vehicules", materielId) || {}).statut] || "") :
              (MAT_ETAT_LABELS[(DB.get("materiels", materielId) || {}).etat] || "");
            LM.toast("Ticket enregistré." + (etatMsg ? " État actuel : " + etatMsg + "." : ""), "success");
            LM.closeModal();
            render(content);
          });
        }
      });
    }

    // ------------------------------------------------------------------
    // Contrôle général d'un véhicule (check-list), sans demande de réparation préalable.
    // Le statut et la priorité du ticket sont déduits automatiquement de l'état des parties
    // contrôlées : dès qu'une anomalie ("Problème détecté") est cochée, le ticket redevient
    // actif ("À réparer") pour être suivi comme une réparation classique.
    // ------------------------------------------------------------------
    function openControleForm(existing, presetVehiculeId) {
      var isEdit = !!existing;
      var t = existing || {
        materielType: "vehicule", materielId: presetVehiculeId || "",
        nature: "controle",
        titre: "Contrôle général", description: "", priorite: "basse", immobilise: false, statut: "termine",
        creePar: "", dateCreation: DB.todayISO(),
        reparateur: "", dateDebut: DB.todayISO(), dateFin: DB.todayISO(), cout: "", compteRendu: "",
        checklist: []
      };
      var parts = DB.listeItems("partiesControle");
      var existingChecklist = t.checklist || [];
      function findChecklistItem(key) { return existingChecklist.find(function (c) { return c.key === key; }); }

      var refSuffix = isEdit ? " (" + DB.fmtTicketRef(t.ticketNumber) + ")" : "";

      var checklistHtml = !parts.length ?
        '<div class="pr-empty" style="background:var(--color-surface-alt);border:1px dashed var(--color-border-strong);border-radius:10px;padding:16px;text-align:center;color:var(--color-text-faint);font-size:0.85rem;">' +
          'Aucune partie définie pour le moment — ajoutez-en depuis la page <strong>Annexes</strong>.' +
        '</div>' :
        '<div class="grid grid-2">' +
          parts.map(function (p) {
            var existingItem = findChecklistItem(p.key);
            var checked = !!existingItem;
            var etat = existingItem ? existingItem.etat : "ras";
            var remarque = existingItem ? (existingItem.remarque || "") : "";
            var etatCls = etat === "surveiller" ? " cl-etat-surveiller" : (etat === "probleme" ? " cl-etat-probleme" : "");
            return '<div class="checklist-item' + etatCls + '">' +
              '<label class="checkbox-row"><input type="checkbox" class="cl-check" data-key="' + p.key + '" data-label="' + LM.escapeHtml(p.label) + '"' + (checked ? " checked" : "") + ' /> ' + LM.escapeHtml(p.label) + '</label>' +
              '<div class="checklist-item-detail' + (checked ? " open" : "") + '">' +
                '<select class="cl-etat">' +
                  '<option value="ras"' + (etat === "ras" ? " selected" : "") + '>RAS — bon état</option>' +
                  '<option value="surveiller"' + (etat === "surveiller" ? " selected" : "") + '>À surveiller</option>' +
                  '<option value="probleme"' + (etat === "probleme" ? " selected" : "") + '>Problème détecté</option>' +
                '</select>' +
                '<input type="text" class="cl-remarque" placeholder="Remarque (optionnel)" value="' + LM.escapeHtml(remarque) + '" />' +
              '</div>' +
            '</div>';
          }).join("") +
        '</div>';

      LM.openModal({
        title: (isEdit ? "Modifier le contrôle" : "Nouveau contrôle général") + refSuffix,
        wide: true,
        bodyHtml:
          '<form id="controleForm">' +
            (isEdit ?
              '<p class="text-sm"><strong>Véhicule :</strong> ' + LM.escapeHtml(ticketMaterielCurrentLabel(t)) + ' <span class="text-faint">(non modifiable)</span>' +
                ' &nbsp;·&nbsp; <strong>Référence :</strong> <span class="badge badge-accent">' + LM.escapeHtml(DB.fmtTicketRef(t.ticketNumber)) + '</span></p>' :
              '<div class="field"><label>Véhicule concerné *</label><select name="materielId" id="controleVeh" required>' + itemOptions("vehicule", t.materielId) + '</select></div>'
            ) +
            field("Titre", "titre", t.titre, "text", false, "ex : Contrôle général, révision hebdomadaire…") +
            '<div class="form-row">' +
              field("Contrôlé par", "reparateur", t.reparateur, "text", false, "Nom du réparateur / mécanicien") +
              field("Date du contrôle", "dateCreation", t.dateCreation, "date") +
            '</div>' +
            '<div class="field">' +
              '<label>Parties contrôlées</label>' +
              '<p class="text-sm text-faint" style="margin:0 0 10px;">Cochez chaque partie inspectée puis précisez son état. Les parties proposées se gèrent depuis la page Annexes.</p>' +
              checklistHtml +
            '</div>' +
            '<div class="checkbox-row" style="margin:16px 0 14px;">' +
              '<input type="checkbox" name="immobilise" id="controleImmobilise"' + (t.immobilise ? " checked" : "") + ' />' +
              '<label for="controleImmobilise" style="margin:0;">Immobiliser le véhicule suite à ce contrôle</label>' +
            '</div>' +
            field("Coût (€)", "cout", t.cout, "number", false, "Pièces déjà remplacées lors du contrôle, si applicable") +
            '<div class="field"><label>Observations générales</label><textarea name="compteRendu">' + LM.escapeHtml(t.compteRendu || "") + '</textarea></div>' +
            '<p class="hint">Le statut du ticket (« À réparer » ou « Réparé ») est calculé automatiquement selon les anomalies cochées ci-dessus.</p>' +
          '</form>',
        footerHtml:
          '<button class="btn btn-secondary" id="cancelBtn">Annuler</button>' +
          (isEdit ? '<button class="btn btn-danger" id="deleteBtn">Supprimer ce contrôle</button>' : '') +
          '<button class="btn btn-primary" id="saveBtn">' + (isEdit ? "Enregistrer" : "Enregistrer le contrôle") + '</button>',
        onMount: function (modal) {
          modal.querySelectorAll(".cl-check").forEach(function (cb) {
            cb.addEventListener("change", function () {
              var item = cb.closest(".checklist-item");
              item.querySelector(".checklist-item-detail").classList.toggle("open", cb.checked);
            });
          });
          modal.querySelectorAll(".cl-etat").forEach(function (sel) {
            sel.addEventListener("change", function () {
              var item = sel.closest(".checklist-item");
              item.classList.remove("cl-etat-surveiller", "cl-etat-probleme");
              if (sel.value === "surveiller") item.classList.add("cl-etat-surveiller");
              if (sel.value === "probleme") item.classList.add("cl-etat-probleme");
            });
          });
          modal.querySelector("#cancelBtn").addEventListener("click", LM.closeModal);
          if (isEdit) {
            modal.querySelector("#deleteBtn").addEventListener("click", function () {
              LM.confirmDialog("Supprimer définitivement ce contrôle ?", function () {
                DB.remove("ticketsReparation", t.id);
                DB.recalcEtatMateriel(t.materielType, t.materielId);
                DB.logHistorique("Réparations", "suppression", "Suppression contrôle : " + t.titre);
                LM.toast("Contrôle supprimé.", "success");
                LM.closeModal();
                render(content);
              });
            });
          }
          modal.querySelector("#saveBtn").addEventListener("click", function () {
            var form = modal.querySelector("#controleForm");
            var fd = new FormData(form);
            var vehiculeId = isEdit ? t.materielId : (fd.get("materielId") || "");
            if (!vehiculeId) { LM.toast("Merci de sélectionner le véhicule concerné.", "danger"); return; }

            var checklist = [];
            modal.querySelectorAll(".checklist-item").forEach(function (item) {
              var cb = item.querySelector(".cl-check");
              if (!cb || !cb.checked) return;
              checklist.push({
                key: cb.getAttribute("data-key"),
                label: cb.getAttribute("data-label"),
                etat: item.querySelector(".cl-etat").value,
                remarque: item.querySelector(".cl-remarque").value.trim()
              });
            });
            if (!checklist.length) { LM.toast("Cochez au moins une partie contrôlée.", "danger"); return; }

            var hasProbleme = checklist.some(function (c) { return c.etat === "probleme"; });
            var hasSurveiller = checklist.some(function (c) { return c.etat === "surveiller"; });
            var computedStatut = hasProbleme ? "nouveau" : "termine";
            var computedPriorite = hasProbleme ? "haute" : (hasSurveiller ? "normale" : "basse");

            var titre = (fd.get("titre") || "").toString().trim() || "Contrôle général";
            var dateControle = fd.get("dateCreation") || DB.todayISO();
            var coutRaw = (fd.get("cout") || "").toString().trim();

            var payload = {
              materielType: "vehicule", materielId: vehiculeId,
              materielLabel: DB.materielLabel("vehicule", vehiculeId) || (isEdit ? t.materielLabel : ""),
              nature: "controle",
              titre: titre,
              description: "",
              priorite: computedPriorite,
              statut: computedStatut,
              immobilise: fd.get("immobilise") === "on",
              creePar: "",
              dateCreation: dateControle,
              reparateur: (fd.get("reparateur") || "").toString().trim(),
              dateDebut: dateControle,
              dateFin: computedStatut === "termine" ? dateControle : "",
              cout: coutRaw === "" ? "" : (Number(coutRaw) || 0),
              compteRendu: (fd.get("compteRendu") || "").toString().trim(),
              checklist: checklist
            };
            if (isEdit) {
              DB.update("ticketsReparation", t.id, payload);
              DB.logHistorique("Réparations", "modification", "Modification contrôle : " + titre + (hasProbleme ? " (anomalie détectée)" : " (RAS)"));
            } else {
              payload.ticketNumber = DB.nextTicketNumber();
              DB.add("ticketsReparation", payload);
              DB.logHistorique("Réparations", "ajout", "Ajout contrôle : " + titre + (hasProbleme ? " (anomalie détectée)" : " (RAS)"));
            }
            DB.recalcEtatMateriel("vehicule", vehiculeId);

            LM.toast(
              "Contrôle enregistré." + (hasProbleme ? " Anomalie(s) détectée(s) : le ticket est repassé « À réparer »." : " Aucune anomalie : contrôle clos."),
              hasProbleme ? undefined : "success"
            );
            LM.closeModal();
            render(content);
          });
        }
      });
    }
  }

  // Libellé du matériel affiché sur un ticket : on retombe sur le libellé mémorisé à la
  // création du ticket si le véhicule/matériel d'origine a depuis été supprimé.
  function ticketMaterielCurrentLabel(t) {
    return DB.materielLabel(t.materielType, t.materielId) || t.materielLabel || "Élément supprimé";
  }

  // ------------------------------------------------------------------
  // Export PDF de l'historique complet des tickets, avec choix de la période
  // et des statuts à inclure dans une pop-up.
  // ------------------------------------------------------------------
  function openExportPdfModal() {
    var statutsAll = Object.keys(STATUT_LABELS);
    var naturesAll = Object.keys(NATURE_LABELS);
    var vehiculesAll = DB.list("vehicules");
    var materielsAll = DB.list("materiels");
    var materielOptionsCount = vehiculesAll.length + materielsAll.length;
    LM.openModal({
      title: "Exporter l'historique des réparations en PDF",
      wide: true,
      bodyHtml:
        '<p class="text-sm text-faint" style="margin-top:0;">Générez un rapport PDF au design professionnel de l\'historique des tickets, filtré par période, véhicule/matériel, nature et statut.</p>' +
        '<div class="form-row">' +
          '<div class="field"><label>Du</label><input type="date" id="pdfDateStart" /></div>' +
          '<div class="field"><label>Au</label><input type="date" id="pdfDateEnd" /></div>' +
          '<div class="field"><label>Trier par date de création</label><select id="pdfOrder">' +
            '<option value="asc">Du plus ancien au plus récent</option>' +
            '<option value="desc">Du plus récent au plus ancien</option>' +
          '</select></div>' +
        '</div>' +
        (materielOptionsCount ?
          '<div class="field"><label>Véhicules / matériel à inclure</label><select id="pdfMateriel" multiple size="6">' +
            (vehiculesAll.length ? '<optgroup label="Véhicules">' +
              vehiculesAll.map(function (v) { return '<option value="vehicule:' + v.id + '" selected>' + LM.escapeHtml(v.plaque) + '</option>'; }).join("") +
            '</optgroup>' : '') +
            (materielsAll.length ? '<optgroup label="Autre matériel">' +
              materielsAll.map(function (m) { return '<option value="materiel:' + m.id + '" selected>' + LM.escapeHtml(m.nom) + '</option>'; }).join("") +
            '</optgroup>' : '') +
          '</select><div class="hint">Tous sélectionnés par défaut. Maintenez Ctrl (Cmd sur Mac) enfoncé pour n\'en garder que certains, ou cliquez sur un seul élément pour ne garder que celui-ci.</div></div>' : '') +
        '<div class="field"><label>Nature à inclure</label>' +
          naturesAll.map(function (k) {
            return '<label class="checkbox-row" style="margin-bottom:8px;"><input type="checkbox" data-pdfnature="' + k + '" checked /> ' + NATURE_LABELS[k] + '</label>';
          }).join("") +
        '</div>' +
        '<div class="field"><label>Statuts à inclure</label>' +
          statutsAll.map(function (k) {
            return '<label class="checkbox-row" style="margin-bottom:8px;"><input type="checkbox" data-pdfstatut="' + k + '" checked /> ' + STATUT_LABELS[k] + '</label>';
          }).join("") +
        '</div>' +
        '<p class="hint">Laissez les dates vides pour inclure tout l\'historique (basé sur la date de création du ticket).</p>',
      footerHtml:
        '<button class="btn btn-secondary" id="pdfCancel">Annuler</button>' +
        '<button class="btn btn-pdf" id="pdfGo">' + LM.icon("file") + ' Générer le PDF</button>',
      onMount: function (modal) {
        modal.querySelector("#pdfCancel").addEventListener("click", LM.closeModal);
        modal.querySelector("#pdfGo").addEventListener("click", function () {
          var start = modal.querySelector("#pdfDateStart").value || "";
          var end = modal.querySelector("#pdfDateEnd").value || "";
          if (start && end && start > end) { LM.toast("La date de début doit précéder la date de fin.", "danger"); return; }
          var order = modal.querySelector("#pdfOrder").value;
          var statuts = Array.prototype.slice.call(modal.querySelectorAll("[data-pdfstatut]"))
            .filter(function (cb) { return cb.checked; })
            .map(function (cb) { return cb.getAttribute("data-pdfstatut"); });
          if (!statuts.length) { LM.toast("Sélectionnez au moins un statut à inclure.", "danger"); return; }
          var natures = Array.prototype.slice.call(modal.querySelectorAll("[data-pdfnature]"))
            .filter(function (cb) { return cb.checked; })
            .map(function (cb) { return cb.getAttribute("data-pdfnature"); });
          if (!natures.length) { LM.toast("Sélectionnez au moins une nature de ticket à inclure.", "danger"); return; }

          var materielSelect = modal.querySelector("#pdfMateriel");
          var materielSet = null, materielCount = materielOptionsCount, materielLabels = [];
          if (materielSelect) {
            var selectedOpts = Array.prototype.slice.call(materielSelect.selectedOptions);
            if (!selectedOpts.length) { LM.toast("Sélectionnez au moins un véhicule ou matériel.", "danger"); return; }
            materielCount = selectedOpts.length;
            materielSet = {};
            selectedOpts.forEach(function (o) { materielSet[o.value] = true; materielLabels.push(o.textContent); });
          }

          var tickets = DB.list("ticketsReparation").filter(function (t) {
            if (statuts.indexOf(t.statut) === -1) return false;
            if (natures.indexOf(t.nature || "reparation") === -1) return false;
            if (materielSet && !materielSet[t.materielType + ":" + t.materielId]) return false;
            if (start && (t.dateCreation || "") < start) return false;
            if (end && (t.dateCreation || "") > end) return false;
            return true;
          }).sort(function (a, b) {
            var cmp = (a.dateCreation || "").localeCompare(b.dateCreation || "");
            return order === "desc" ? -cmp : cmp;
          });
          LM.closeModal();
          exportTicketsPdf(tickets, {
            start: start, end: end, order: order,
            statuts: statuts, statutsAll: statutsAll, natures: natures, naturesAll: naturesAll,
            materielCount: materielCount, materielTotal: materielOptionsCount, materielLabels: materielLabels
          });
        });
      }
    });
  }

  function exportTicketsPdf(tickets, filters) {
    var statutLabel = filters.statuts.length === filters.statutsAll.length ?
      "Tous statuts" : filters.statuts.map(function (k) { return STATUT_LABELS[k]; }).join(", ");
    var natureLabel = filters.natures.length === filters.naturesAll.length ?
      "Toutes natures" : filters.natures.map(function (k) { return NATURE_LABELS[k]; }).join(", ");
    var periodeLabel = (filters.start || filters.end) ?
      "Période : " + (filters.start ? DB.fmtDate(filters.start) : "origine") + " → " + (filters.end ? DB.fmtDate(filters.end) : "aujourd'hui") :
      "Période : historique complet";
    var ordreLabel = "Tri : " + (filters.order === "desc" ? "du plus récent au plus ancien" : "du plus ancien au plus récent");
    var materielLabel = (filters.materielTotal === undefined || filters.materielCount === filters.materielTotal) ?
      "Véhicules/matériel : tous" :
      "Véhicules/matériel : " + (filters.materielLabels && filters.materielLabels.length <= 5 ? filters.materielLabels.join(", ") : filters.materielCount + " sélectionné(s)");
    var subtitle = LM.escapeHtml(periodeLabel + "\n" + materielLabel + "\nNature : " + natureLabel + "\nStatuts : " + statutLabel + "\n" + ordreLabel);

    var nbTotal = tickets.length;
    var coutTotal = tickets.reduce(function (a, t) { return a + (Number(t.cout) || 0); }, 0);
    var nbImmobilisants = tickets.filter(function (t) { return t.immobilise; }).length;
    var nbTermines = tickets.filter(function (t) { return t.statut === "termine"; }).length;
    var nbControles = tickets.filter(function (t) { return t.nature === "controle"; }).length;

    var kpisHtml =
      '<div class="pr-kpis">' +
        '<div class="pr-kpi"><div class="pr-kpi-label">Tickets</div><div class="pr-kpi-value">' + nbTotal + '</div></div>' +
        '<div class="pr-kpi"><div class="pr-kpi-label">Dont contrôles</div><div class="pr-kpi-value">' + nbControles + '</div></div>' +
        '<div class="pr-kpi"><div class="pr-kpi-label">Terminés</div><div class="pr-kpi-value">' + nbTermines + '</div></div>' +
        '<div class="pr-kpi"><div class="pr-kpi-label">Dont immobilisants</div><div class="pr-kpi-value">' + nbImmobilisants + '</div></div>' +
        '<div class="pr-kpi"><div class="pr-kpi-label">Coût total</div><div class="pr-kpi-value">' + DB.fmtEUR(coutTotal) + '</div></div>' +
      '</div>';

    var statutBadgeCls = { nouveau: "pr-badge-info", en_cours: "pr-badge-warning", termine: "pr-badge-success", annule: "pr-badge-neutral" };
    var prioBadgeCls = { basse: "pr-badge-neutral", normale: "pr-badge-info", haute: "pr-badge-warning", urgente: "pr-badge-danger" };
    var natureBadgeCls = { reparation: "pr-badge-info", controle: "pr-badge-accent" };

    var tableHtml;
    if (!tickets.length) {
      tableHtml = '<div class="pr-empty">Aucun ticket ne correspond aux filtres sélectionnés.</div>';
    } else {
      tableHtml =
        '<table class="pr-table"><thead><tr>' +
          '<th>Réf.</th><th>Nature</th><th>Matériel</th><th>Titre</th><th>Priorité</th><th>Statut</th><th>Créé le</th><th>Terminé le</th><th>Réparateur</th><th>Coût</th>' +
        '</tr></thead><tbody>' +
        tickets.map(function (t) {
          var prio = PRIORITES[t.priorite] || PRIORITES.normale;
          var nature = t.nature || "reparation";
          return '<tr>' +
            '<td>' + LM.escapeHtml(DB.fmtTicketRef(t.ticketNumber)) + '</td>' +
            '<td><span class="pr-badge ' + natureBadgeCls[nature] + '">' + NATURE_LABELS[nature] + '</span></td>' +
            '<td>' + LM.escapeHtml(ticketMaterielCurrentLabel(t)) + '</td>' +
            '<td>' + LM.escapeHtml(t.titre) + (t.immobilise ? ' <span class="pr-badge pr-badge-danger">Immobilisant</span>' : '') +
              (t.description ? '<div class="pr-desc">' + LM.escapeHtml(t.description) + '</div>' : '') +
              (t.partieConcernee ? '<div class="pr-desc">Partie : ' + LM.escapeHtml(DB.listeLabel("partiesControle", t.partieConcernee) || t.partieConcernee) + '</div>' : '') + '</td>' +
            '<td><span class="pr-badge ' + (prioBadgeCls[t.priorite] || "pr-badge-neutral") + '">' + prio.label + '</span></td>' +
            '<td><span class="pr-badge ' + (statutBadgeCls[t.statut] || "pr-badge-neutral") + '">' + STATUT_LABELS[t.statut] + '</span></td>' +
            '<td>' + DB.fmtDate(t.dateCreation) + '</td>' +
            '<td>' + (t.dateFin ? DB.fmtDate(t.dateFin) : "—") + '</td>' +
            '<td>' + (t.reparateur ? LM.escapeHtml(t.reparateur) : "—") + '</td>' +
            '<td>' + (t.cout !== "" && t.cout !== undefined && t.cout !== null ? DB.fmtEUR(t.cout) : "—") + '</td>' +
          '</tr>';
        }).join("") +
        '</tbody></table>';
    }

    // Détail des réparations effectuées : le tableau de synthèse ci-dessus tronque le
    // compte-rendu et la période — on ressort ici, pour chaque ticket de réparation, la partie
    // concernée, la période d'intervention, le coût et le compte-rendu complet du réparateur,
    // pour un rapport consultable sans repasser par l'application.
    var reparationTickets = tickets.filter(function (t) { return (t.nature || "reparation") === "reparation"; });
    var reparationSection = "";
    if (reparationTickets.length) {
      reparationSection =
        '<div class="pr-section-title">Détail des réparations effectuées (' + reparationTickets.length + ')</div>' +
        '<table class="pr-table"><thead><tr>' +
          '<th>Réf.</th><th>Matériel</th><th>Partie concernée</th><th>Période</th><th>Coût</th><th>Compte-rendu</th>' +
        '</tr></thead><tbody>' +
        reparationTickets.map(function (t) {
          var duree = (t.dateDebut && t.dateFin) ? Math.max(0, Math.round((new Date(t.dateFin) - new Date(t.dateDebut)) / 86400000)) : null;
          var periode = (t.dateDebut ? DB.fmtDate(t.dateDebut) : "—") + ' → ' + (t.dateFin ? DB.fmtDate(t.dateFin) : "—") +
            (duree !== null ? '<div class="pr-desc">' + duree + ' jour(s)</div>' : '');
          return '<tr>' +
            '<td>' + LM.escapeHtml(DB.fmtTicketRef(t.ticketNumber)) + '<div class="pr-desc">' + LM.escapeHtml(t.titre) + '</div></td>' +
            '<td>' + LM.escapeHtml(ticketMaterielCurrentLabel(t)) + '</td>' +
            '<td>' + (t.partieConcernee ? LM.escapeHtml(DB.listeLabel("partiesControle", t.partieConcernee) || t.partieConcernee) : "—") + '</td>' +
            '<td>' + periode + '</td>' +
            '<td>' + (t.cout !== "" && t.cout !== undefined && t.cout !== null ? DB.fmtEUR(t.cout) : "—") + '</td>' +
            '<td>' + (t.compteRendu ? LM.escapeHtml(t.compteRendu) : '<span class="pr-desc">—</span>') + '</td>' +
          '</tr>';
        }).join("") +
        '</tbody></table>';
    }

    // Détail des contrôles inclus dans l'export : une mini check-list par contrôle, pour
    // conserver la traçabilité complète des parties inspectées (et pas seulement la ligne de
    // synthèse du tableau ci-dessus).
    var controleTickets = tickets.filter(function (t) { return t.nature === "controle" && (t.checklist || []).length; });
    var controleSection = "";
    if (controleTickets.length) {
      var etatBadgeCls = { ras: "pr-badge-success", surveiller: "pr-badge-warning", probleme: "pr-badge-danger" };
      var etatLabel = { ras: "RAS", surveiller: "À surveiller", probleme: "Problème détecté" };
      controleSection =
        '<div class="pr-section-title">Détail des contrôles effectués (' + controleTickets.length + ')</div>' +
        controleTickets.map(function (t) {
          return '<p style="font-size:12px;font-weight:700;margin:14px 0 4px;">' +
              LM.escapeHtml(DB.fmtTicketRef(t.ticketNumber)) + ' — ' + LM.escapeHtml(ticketMaterielCurrentLabel(t)) +
              ' <span style="font-weight:400;color:#6b7280;">(' + DB.fmtDate(t.dateCreation) + (t.reparateur ? ' · ' + LM.escapeHtml(t.reparateur) : '') + ')</span>' +
            '</p>' +
            '<table class="pr-table"><thead><tr><th>Partie contrôlée</th><th>État</th><th>Remarque</th></tr></thead><tbody>' +
              t.checklist.map(function (c) {
                return '<tr>' +
                  '<td>' + LM.escapeHtml(c.label) + '</td>' +
                  '<td><span class="pr-badge ' + (etatBadgeCls[c.etat] || "pr-badge-neutral") + '">' + (etatLabel[c.etat] || c.etat) + '</span></td>' +
                  '<td>' + (c.remarque ? LM.escapeHtml(c.remarque) : "—") + '</td>' +
                '</tr>';
              }).join("") +
            '</tbody></table>';
        }).join("");
    }

    var body = kpisHtml + '<div class="pr-section-title">Détail des tickets (' + nbTotal + ')</div>' + tableHtml + reparationSection + controleSection;
    LM.printReport("Historique des réparations", body, { subtitle: subtitle });
  }

  function field(label, name, value, type, required, hint) {
    type = type || "text";
    return '<div class="field"><label>' + label + '</label>' +
      '<input type="' + type + '" name="' + name + '" value="' + LM.escapeHtml(value !== undefined && value !== null ? value : "") + '"' + (required ? " required" : "") + ' />' +
      (hint ? '<div class="hint">' + hint + '</div>' : '') +
      '</div>';
  }

  function kpi(iconName, label, value) {
    return '<div class="kpi"><div class="kpi-label"><span class="kpi-icon">' + LM.icon(iconName) + '</span>' + label + '</div><div class="kpi-value">' + value + '</div></div>';
  }
})();


/* ==== js/analyse.js ==== */
/*! analyse.js - Page d'analyse des livraisons : période, KPIs, graphiques, import Excel, saisie manuelle */
(function () {
  "use strict";

  var period = { preset: "30j", start: null, end: null };
  var journalTab = "import";
  var journalPage = 1;
  var PAGE_SIZE = 20;
  var pendingImport = null; // { rows, headers, mapping }
  var selectedIds = {}; // id livraison -> true ; sélection multiple pour la suppression groupée dans l'onglet Historique (persiste entre les pages, réinitialisée au changement d'onglet)
  // Filtres locaux à l'onglet "Historique & imports" : indépendants de la "Période d'analyse"
  // globale (qui pilote les KPI/graphiques des autres onglets), ils permettent de retrouver
  // rapidement une ou plusieurs entrées précises du journal par date, entrepôt et/ou livreur.
  var histDateMode = "toutes"; // "toutes" (période ci-dessus) | "unique" | "periode"
  var histDateSingle = DB.todayISO();
  var histDateStart = null;
  var histDateEnd = null;
  var histEntIds = null; // null = tous ; sinon tableau d'ids (ou UNASSIGNED)
  var histLivIds = null; // idem
  // État de l'onglet Saisie manuelle : les "chips" Dates, Entrepôts et Livreurs servent de palette
  // rapide pour générer des lignes dans la grille (produit cartésien dates × entrepôts, éventuellement
  // × livreurs pré-sélectionnés), mais la grille elle-même (manualGridRows) est la source de vérité une
  // fois générée — chaque ligne conserve ses propres livreur/bacs/livraisons/km/retards/commentaire,
  // modifiable et supprimable/duplicable indépendamment, pour saisir en un seul passage plusieurs jours,
  // plusieurs entrepôts et/ou plusieurs livreurs. Le champ "retards" (colonne "Retards" de la grille)
  // crée, à l'enregistrement, un signalement DB.upsertRetard lié à la nouvelle entrée du journal.
  var manualDates = [DB.todayISO()];
  var manualEntrepots = [];
  var manualLivreurs = []; // livreurs pré-sélectionnés (optionnel) : si vide, les lignes générées restent "Non précisé" (à choisir ligne par ligne)
  var manualGridRows = []; // { id, date, entrepotId, livreurId, nbLivraisons, nbBacs, km, retards, commentaire }

  // Le fichier importé est au niveau "commande" : une ligne = une livraison (un bac/arrêt chez un client).
  // Le nombre de livraisons n'est donc jamais lu depuis une colonne : il vaut toujours 1 par ligne importée,
  // et les KPI/graphiques comptent le nombre de lignes. Seul le nombre de bacs est une valeur par ligne.
  var FIELD_SYNONYMS = {
    date: ["date", "jour"],
    entrepot: ["entrepot", "entrepôt", "site", "warehouse", "depot", "dépôt", "entrepot livraison"],
    livreur: ["livreur", "chauffeur", "driver", "livreur(se)"],
    nbBacs: ["bac", "bacs", "nb bac", "nb bacs", "nombre de bacs", "nb_bacs"],
    tournee: ["tournee", "tournée", "route", "circuit"],
    sequence: ["sequence", "séquence", "ordre", "rang", "passage"],
    client: ["representant du client", "client", "nom client", "contact", "destinataire"],
    numero: ["numero", "numéro", "n°", "num"],
    rue: ["rue", "adresse", "voie"],
    codePostal: ["code postal", "cp", "codepostal"],
    ville: ["ville", "commune", "city"],
    incidents: ["incidents", "incident", "problemes", "problèmes", "anomalies"],
    km: ["km", "kilometres", "kilomètres", "distance", "distance km"],
    commentaire: ["commentaire", "commentaires", "remarque", "remarques", "note", "notes", "observation"]
  };
  var FIELD_LABELS = {
    ignore: "Ignorer cette colonne",
    date: "Date *",
    entrepot: "Entrepôt *",
    livreur: "Livreur",
    nbBacs: "Nb de bacs (par commande)",
    tournee: "Tournée",
    sequence: "Séquence",
    client: "Client",
    numero: "N° de rue",
    rue: "Rue",
    codePostal: "Code postal",
    ville: "Ville",
    incidents: "Incidents",
    km: "Km parcourus",
    commentaire: "Commentaire"
  };

  applyPreset("30j");
  App.registerPage("analyse", { title: "Analyse", subtitle: "Statistiques de livraison sur une période, import de données", render: render });

  // ------------------------------------------------------------------
  // Gestion de la période
  // ------------------------------------------------------------------
  function applyPreset(preset) {
    var end = new Date();
    var start = new Date();
    if (preset === "7j") { start.setDate(end.getDate() - 6); }
    else if (preset === "30j") { start.setDate(end.getDate() - 29); }
    else if (preset === "90j") { start.setDate(end.getDate() - 89); }
    else if (preset === "mois_courant") { start = new Date(end.getFullYear(), end.getMonth(), 1); }
    else if (preset === "mois_dernier") {
      start = new Date(end.getFullYear(), end.getMonth() - 1, 1);
      end = new Date(end.getFullYear(), end.getMonth(), 0);
    }
    period.preset = preset;
    period.start = start.toISOString().slice(0, 10);
    period.end = end.toISOString().slice(0, 10);
  }

  function periodLengthDays() {
    var d1 = new Date(period.start), d2 = new Date(period.end);
    return Math.round((d2 - d1) / 86400000) + 1;
  }

  function previousPeriodRange() {
    var days = periodLengthDays();
    var start = new Date(period.start);
    var prevEnd = new Date(start); prevEnd.setDate(prevEnd.getDate() - 1);
    var prevStart = new Date(prevEnd); prevStart.setDate(prevStart.getDate() - days + 1);
    return { start: prevStart.toISOString().slice(0, 10), end: prevEnd.toISOString().slice(0, 10) };
  }

  function livraisonsInRange(start, end) {
    return DB.list("livraisons").filter(function (r) { return r.date >= start && r.date <= end; });
  }

  // ------------------------------------------------------------------
  // Contrôle des imports (cadre au-dessus du Journal des livraisons)
  //
  // Rapproche le journal des livraisons du Planning : chaque livreur marqué « Travail » un jour
  // donné (et déjà embauché à cette date) doit avoir au moins une entrée dans le journal ce
  // jour-là. Quatre types d'alertes, du plus global au plus précis :
  //   - date       : aucune livraison importée ce jour-là, alors que des livreurs étaient prévus ;
  //   - entrepot   : des livraisons existent ce jour-là, mais aucune pour cet entrepôt ;
  //   - livreur    : l'entrepôt a des livraisons, mais pas pour ce livreur prévu au planning ;
  //   - incoherence: des livraisons sont saisies pour un livreur en repos/absence au planning,
  //                  ou avant sa date d'embauche.
  // Le contrôle suit la « Période d'analyse » choisie en haut de page et s'arrête à hier
  // (la journée en cours n'est pas terminée, donc pas encore attendue).
  // ------------------------------------------------------------------
  var ctrlFilter = "all"; // all | date | entrepot | livreur | incoherence
  var ctrlShowAll = false;
  var ctrlShowIgnored = false;
  var CTRL_VISIBLE = 6;
  var CTRL_KINDS = {
    date: { label: "Dates", icon: "calendar", color: "#d64545", tint: "#fbe9e9" },
    entrepot: { label: "Entrepôts", icon: "entrepot", color: "#e07400", tint: "#fff1e0" },
    livreur: { label: "Livreurs", icon: "livreur", color: "#3454d1", tint: "#e8ecfd" },
    incoherence: { label: "Incohérences", icon: "alert", color: "#7c4dd6", tint: "#f0eafb" }
  };
  var CTRL_ORDER = { date: 0, entrepot: 1, livreur: 2, incoherence: 3 };
  var manualSync = null; // recopie la grille de saisie manuelle affichée dans manualGridRows (voir renderManualTab)

  function ctrlAddDays(iso, n) {
    var p = iso.split("-");
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + n);
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + "-" + (m < 10 ? "0" : "") + m + "-" + (day < 10 ? "0" : "") + day;
  }

  function ctrlDateLabel(iso) {
    return new Date(iso + "T00:00:00").toLocaleDateString("fr-FR", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" });
  }

  function ctrlPrimaryEntrepot(l) {
    return (l && Array.isArray(l.entrepotIds) && l.entrepotIds[0]) || null;
  }

  function ctrlTypeLabel(type) {
    if (type === "repos") return "Repos";
    if (type === "travail") return "Travail";
    return DB.listeLabel("typesAbsence", type) || "Absence";
  }

  function computeControle(start, end) {
    var yesterday = ctrlAddDays(DB.todayISO(), -1);
    var last = end < yesterday ? end : yesterday;
    var res = { notifs: [], last: last, jours: 0, prevues: 0, couvertes: 0, planningVide: true };
    if (!start || start > last) return res;

    var livreurs = DB.list("livreurs");
    var byDate = {};
    DB.list("livraisons").forEach(function (r) {
      if (r.date < start || r.date > last) return;
      var o = byDate[r.date];
      if (!o) { o = byDate[r.date] = { total: 0, liv: {}, ent: {} }; }
      o.total++;
      if (r.livreurId) o.liv[r.livreurId] = (o.liv[r.livreurId] || 0) + 1;
      if (r.entrepotId) o.ent[r.entrepotId] = (o.ent[r.entrepotId] || 0) + 1;
    });
    var plan = {};
    DB.list("planningEntrees").forEach(function (e) {
      if (e.date >= start && e.date <= last) { plan[e.livreurId + "|" + e.date] = e; res.planningVide = false; }
    });
    var actifs = livreurs.filter(function (l) { return l.statut !== "inactif"; });

    var d = start;
    while (d <= last) {
      res.jours++;
      var info = byDate[d] || { total: 0, liv: {}, ent: {} };
      var dd = d;
      var present = actifs.filter(function (l) {
        var e = plan[l.id + "|" + dd];
        return DB.livreurEmbaucheLe(l, dd) && e && e.type === "travail";
      });
      res.prevues += present.length;
      var uncovered = present.filter(function (l) { return !info.liv[l.id]; });
      res.couvertes += present.length - uncovered.length;

      if (uncovered.length) {
        if (info.total === 0) {
          // Rien d'importé ce jour-là : une seule alerte « date » plutôt qu'une par livreur.
          var ents = [];
          present.forEach(function (l) { var pe = ctrlPrimaryEntrepot(l); if (pe && ents.indexOf(pe) === -1) ents.push(pe); });
          res.notifs.push({ key: "date|" + d, kind: "date", date: d, entrepotIds: ents, livreurIds: present.map(function (l) { return l.id; }) });
        } else {
          var groups = {};
          uncovered.forEach(function (l) {
            var pe = ctrlPrimaryEntrepot(l) || "";
            (groups[pe] = groups[pe] || []).push(l);
          });
          Object.keys(groups).forEach(function (pe) {
            var arr = groups[pe];
            if (pe && !info.ent[pe]) {
              res.notifs.push({ key: "entrepot|" + dd + "|" + pe, kind: "entrepot", date: dd, entrepotIds: [pe], livreurIds: arr.map(function (l) { return l.id; }) });
            } else {
              arr.forEach(function (l) {
                res.notifs.push({ key: "livreur|" + dd + "|" + l.id, kind: "livreur", date: dd, entrepotIds: pe ? [pe] : [], livreurIds: [l.id] });
              });
            }
          });
        }
      }

      // Incohérences : livraisons saisies pour un livreur absent/en repos, ou pas encore embauché.
      Object.keys(info.liv).forEach(function (livId) {
        var l = DB.get("livreurs", livId);
        if (!l) return;
        var e = plan[livId + "|" + dd];
        var reason = null, label = "";
        if (!DB.livreurEmbaucheLe(l, dd)) { reason = "embauche"; label = "avant l'embauche"; }
        else if (e && e.type !== "travail") { reason = "absence"; label = ctrlTypeLabel(e.type); }
        if (!reason) return;
        var pe = ctrlPrimaryEntrepot(l);
        res.notifs.push({ key: "incoherence|" + dd + "|" + livId, kind: "incoherence", date: dd, entrepotIds: pe ? [pe] : [], livreurIds: [livId], reason: reason, reasonLabel: label, count: info.liv[livId] });
      });

      d = ctrlAddDays(d, 1);
    }

    res.notifs.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1; // plus récent d'abord
      return CTRL_ORDER[a.kind] - CTRL_ORDER[b.kind];
    });
    return res;
  }

  function ctrlEntrepotNames(ids) {
    return ids.map(function (id) { return DB.entrepotNom(id) || "Entrepôt supprimé"; });
  }

  function ctrlLivreurName(id) {
    return DB.livreurNom(id) || "Livreur supprimé";
  }

  function ctrlNotifText(n) {
    var nbLiv = n.livreurIds.length;
    if (n.kind === "date") {
      return {
        title: "Aucune livraison importée ce jour-là",
        sub: nbLiv + " livreur" + (nbLiv > 1 ? "s" : "") + " prévu" + (nbLiv > 1 ? "s" : "") + " au planning, aucune entrée dans le journal."
      };
    }
    if (n.kind === "entrepot") {
      return {
        title: "Aucune livraison pour cet entrepôt",
        sub: nbLiv + " livreur" + (nbLiv > 1 ? "s" : "") + " prévu" + (nbLiv > 1 ? "s" : "") + " : " + n.livreurIds.map(ctrlLivreurName).join(", ") + "."
      };
    }
    if (n.kind === "livreur") {
      var e = DB.planningEntreeFor(n.livreurIds[0], n.date);
      var h = e && e.heureDebut ? " (" + e.heureDebut + "–" + e.heureFin + ")" : "";
      return { title: "Aucune livraison pour ce livreur", sub: "Prévu au planning" + h + ", mais aucune entrée dans le journal ce jour-là." };
    }
    if (n.reason === "embauche") {
      var l = DB.get("livreurs", n.livreurIds[0]);
      return { title: "Livraisons avant l'embauche", sub: n.count + " entrée" + (n.count > 1 ? "s" : "") + " pour un livreur embauché le " + DB.fmtDate(l && l.dateEmbauche) + "." };
    }
    return { title: "Livraisons un jour d'absence", sub: n.count + " entrée" + (n.count > 1 ? "s" : "") + " alors que le planning indique « " + n.reasonLabel + " »." };
  }

  function ctrlChipsHtml(n) {
    var html = '<span class="ctrl-chip">' + LM.icon("calendar") + LM.escapeHtml(ctrlDateLabel(n.date)) + '</span>';
    ctrlEntrepotNames(n.entrepotIds).forEach(function (nm) { html += '<span class="ctrl-chip">' + LM.icon("entrepot") + LM.escapeHtml(nm) + '</span>'; });
    if (n.kind === "livreur" || n.kind === "incoherence") {
      html += '<span class="ctrl-chip">' + LM.icon("livreur") + LM.escapeHtml(ctrlLivreurName(n.livreurIds[0])) + '</span>';
    }
    return html;
  }

  function renderControlCard() {
    var card = document.getElementById("controlCard");
    if (!card) return;
    var res = computeControle(period.start, period.end);
    var ign = DB.getControleIgnores();
    var active = res.notifs.filter(function (n) { return !ign[n.key]; });
    var ignoredN = res.notifs.length - active.length;
    var counts = { date: 0, entrepot: 0, livreur: 0, incoherence: 0 };
    active.forEach(function (n) { counts[n.kind]++; });
    var base = ctrlShowIgnored ? res.notifs : active;
    var shown = ctrlFilter === "all" ? base : base.filter(function (n) { return n.kind === ctrlFilter; });
    var visible = ctrlShowAll ? shown : shown.slice(0, CTRL_VISIBLE);
    var pct = res.prevues ? Math.round((res.couvertes / res.prevues) * 100) : 100;
    var rangeTxt = res.last >= period.start ? "du " + DB.fmtDate(period.start) + " au " + DB.fmtDate(res.last) : "";

    var statusBadge = !res.prevues && res.planningVide ? '<span class="badge badge-muted">Planning vide</span>' :
      (active.length ? '<span class="badge badge-warning">' + active.length + ' à vérifier</span>' : '<span class="badge badge-success">À jour</span>');

    var filtersHtml = '<button type="button" class="ctrl-filter' + (ctrlFilter === "all" ? " active" : "") + '" data-ctrlf="all">Tout <span class="ctrl-filter-n">' + active.length + '</span></button>' +
      Object.keys(CTRL_KINDS).map(function (k) {
        return '<button type="button" class="ctrl-filter' + (ctrlFilter === k ? " active" : "") + '" data-ctrlf="' + k + '"><span class="ctrl-dot" style="background:' + CTRL_KINDS[k].color + ';"></span>' + CTRL_KINDS[k].label + ' <span class="ctrl-filter-n">' + counts[k] + '</span></button>';
      }).join("");

    var listHtml;
    if (!res.prevues && res.planningVide && !res.notifs.length) {
      listHtml = '<div class="ctrl-empty">' + LM.icon("calendar") + '<div><strong>Aucun jour « Travail » dans le planning sur cette période.</strong><br><span class="text-sm">Le contrôle compare le journal aux jours travaillés du Planning : renseignez-le (ou utilisez « Proposer planning ») pour activer les alertes.</span></div><a class="btn btn-secondary btn-sm" href="#/planning">Ouvrir le planning</a></div>';
    } else if (!shown.length) {
      listHtml = '<div class="ctrl-empty ctrl-empty-ok">' + LM.icon("check") + '<div><strong>' + (active.length ? "Aucune alerte dans cette catégorie." : "Tout est à jour.") + '</strong><br><span class="text-sm">' + (active.length ? "Choisissez une autre catégorie ci-dessus pour voir les alertes restantes." : "Chaque livreur prévu au planning a des livraisons importées sur la période contrôlée.") + '</span></div></div>';
    } else {
      listHtml = '<div class="ctrl-list">' + visible.map(function (n) {
        var k = CTRL_KINDS[n.kind], t = ctrlNotifText(n), isIgn = !!ign[n.key];
        return '<div class="ctrl-notif' + (isIgn ? " ctrl-ignored" : "") + '" data-ctrlkey="' + LM.escapeHtml(n.key) + '" role="button" tabindex="0" style="--ctrl-color:' + k.color + ';--ctrl-tint:' + k.tint + ';" title="Cliquer pour voir le détail et les actions">' +
          '<span class="ctrl-notif-icon">' + LM.icon(k.icon) + '</span>' +
          '<div class="ctrl-notif-body">' +
            '<div class="ctrl-notif-title">' + LM.escapeHtml(t.title) + (isIgn ? ' <span class="badge badge-muted">Ignorée</span>' : '') + '</div>' +
            '<div class="ctrl-notif-chips">' + ctrlChipsHtml(n) + '</div>' +
            '<div class="ctrl-notif-sub">' + LM.escapeHtml(t.sub) + '</div>' +
          '</div>' +
          '<div class="ctrl-notif-actions">' +
            (isIgn ? '<button type="button" class="btn btn-secondary btn-sm" data-ctrlrestore="' + LM.escapeHtml(n.key) + '">Restaurer</button>' :
              '<button type="button" class="btn btn-primary btn-sm" data-ctrlquick="' + LM.escapeHtml(n.key) + '">' + (n.kind === "incoherence" ? LM.icon("eye") + ' Voir' : LM.icon("edit") + ' Saisir') + '</button>' +
              '<button type="button" class="btn btn-ghost btn-sm btn-icon" data-ctrlignore="' + LM.escapeHtml(n.key) + '" title="Ignorer cette alerte">' + LM.icon("close") + '</button>') +
          '</div>' +
        '</div>';
      }).join("") + '</div>' +
      (shown.length > CTRL_VISIBLE ? '<div class="ctrl-more"><button type="button" class="btn btn-secondary btn-sm" id="ctrlMoreBtn">' + (ctrlShowAll ? "Réduire la liste" : "Afficher les " + (shown.length - CTRL_VISIBLE) + " autres alertes") + '</button></div>' : '');
    }

    card.innerHTML =
      '<div class="card-header"><div><h2>Contrôle des imports</h2><p>Compare le journal des livraisons au Planning (jours « Travail ») ' + (rangeTxt ? rangeTxt + ', hier au plus tard' : 'sur la période choisie') + ' — pour repérer les dates, entrepôts ou livreurs oubliés.</p></div>' + statusBadge + '</div>' +
      '<div class="ctrl-summary">' +
        '<div class="ctrl-cover"><div class="ctrl-cover-top"><span>Couverture des imports</span><strong>' + pct + ' %</strong></div><div class="ctrl-bar"><div class="ctrl-bar-fill' + (pct < 100 ? " ctrl-bar-warn" : "") + '" style="width:' + pct + '%;"></div></div><div class="text-sm text-faint">' + DB.fmtNum(res.couvertes) + ' / ' + DB.fmtNum(res.prevues) + ' journées de livreur prévues ont des livraisons importées</div></div>' +
        '<div class="ctrl-filters">' + filtersHtml + '</div>' +
      '</div>' +
      (ignoredN || ctrlShowIgnored ? '<div class="ctrl-toolbar"><button type="button" class="text-link" id="ctrlToggleIgnored">' + (ctrlShowIgnored ? "Masquer les alertes ignorées" : "Afficher les alertes ignorées (" + ignoredN + ")") + '</button></div>' : '') +
      listHtml;

    card.querySelectorAll("[data-ctrlf]").forEach(function (b) {
      b.addEventListener("click", function () { ctrlFilter = b.getAttribute("data-ctrlf"); ctrlShowAll = false; renderControlCard(); });
    });
    var tg = card.querySelector("#ctrlToggleIgnored");
    if (tg) tg.addEventListener("click", function () { ctrlShowIgnored = !ctrlShowIgnored; renderControlCard(); });
    var more = card.querySelector("#ctrlMoreBtn");
    if (more) more.addEventListener("click", function () { ctrlShowAll = !ctrlShowAll; renderControlCard(); });

    function byKey(key) { return res.notifs.filter(function (n) { return n.key === key; })[0]; }
    card.querySelectorAll(".ctrl-notif").forEach(function (el) {
      function open() { var n = byKey(el.getAttribute("data-ctrlkey")); if (n) openControleModal(n); }
      el.addEventListener("click", open);
      el.addEventListener("keydown", function (e) { if (e.target === el && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); open(); } });
    });
    card.querySelectorAll("[data-ctrlquick]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        var n = byKey(b.getAttribute("data-ctrlquick"));
        if (!n) return;
        if (n.kind === "incoherence") ctrlShowEntries(n); else ctrlPrefillManual(n, n.livreurIds);
      });
    });
    card.querySelectorAll("[data-ctrlignore]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        DB.setControleIgnore(b.getAttribute("data-ctrlignore"), true);
        LM.toast("Alerte ignorée. Vous pouvez la retrouver via « Afficher les alertes ignorées ».", "success");
        renderControlCard();
      });
    });
    card.querySelectorAll("[data-ctrlrestore]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        DB.setControleIgnore(b.getAttribute("data-ctrlrestore"), false);
        renderControlCard();
      });
    });
  }

  function ctrlScrollToJournal() {
    var el = document.getElementById("journalCard");
    if (el && el.scrollIntoView) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // Ouvre « Saisie manuelle » avec les lignes de la grille déjà préparées (date + entrepôt +
  // livreur) pour les livreurs demandés ; l'utilisateur n'a plus qu'à renseigner les chiffres.
  function ctrlPrefillManual(n, livreurIds) {
    if (manualSync && journalTab === "manuel") manualSync();
    var pairs = [], sansEntrepot = 0;
    livreurIds.forEach(function (livId) {
      var l = DB.get("livreurs", livId);
      var entId = ctrlPrimaryEntrepot(l) || (n.entrepotIds.length === 1 ? n.entrepotIds[0] : null);
      if (!entId) { sansEntrepot++; return; }
      pairs.push({ entrepotId: entId, livreurId: livId });
    });
    var untouched = !manualGridRows.length && !manualEntrepots.length && manualDates.length === 1 && manualDates[0] === DB.todayISO();
    if (untouched) manualDates = [];
    if (manualDates.indexOf(n.date) === -1) { manualDates.push(n.date); manualDates.sort(); }
    var added = 0;
    pairs.forEach(function (p) {
      if (manualEntrepots.indexOf(p.entrepotId) === -1) manualEntrepots.push(p.entrepotId);
      var exists = manualGridRows.some(function (r) { return r.date === n.date && r.entrepotId === p.entrepotId && r.livreurId === p.livreurId; });
      if (!exists) {
        manualGridRows.push({ id: DB.uid("mgr"), date: n.date, entrepotId: p.entrepotId, livreurId: p.livreurId, nbLivraisons: "", nbBacs: "", km: "", retards: "", commentaire: "" });
        added++;
      }
    });
    journalTab = "manuel";
    journalPage = 1;
    selectedIds = {};
    LM.closeModal();
    render(document.getElementById("content"));
    ctrlScrollToJournal();
    var msg = added ? added + " ligne" + (added > 1 ? "s" : "") + " préparée" + (added > 1 ? "s" : "") + " dans la saisie manuelle : renseignez les livraisons puis enregistrez." : "Ces lignes sont déjà présentes dans la grille de saisie manuelle.";
    if (sansEntrepot) msg += " " + sansEntrepot + " livreur(s) sans entrepôt rattaché : ajoutez l'entrepôt à la main.";
    LM.toast(msg, added ? "success" : "danger");
  }

  // Affiche dans « Historique & imports » les entrées du jour pour le livreur concerné.
  function ctrlShowEntries(n) {
    histDateMode = "unique";
    histDateSingle = n.date;
    histEntIds = null;
    histLivIds = [n.livreurIds[0]];
    journalTab = "historique";
    journalPage = 1;
    selectedIds = {};
    LM.closeModal();
    render(document.getElementById("content"));
    ctrlScrollToJournal();
  }

  function ctrlOpenPlanning(date) {
    LM.closeModal();
    App.pendingPlanningFocus = date;
    location.hash = "#/planning";
  }

  function openControleModal(n) {
    var ign = !!DB.getControleIgnores()[n.key];
    var t = ctrlNotifText(n), k = CTRL_KINDS[n.kind];
    var isInc = n.kind === "incoherence";
    var rowsHtml = n.livreurIds.map(function (livId) {
      var l = DB.get("livreurs", livId);
      var e = DB.planningEntreeFor(livId, n.date);
      var entNames = l ? ctrlEntrepotNames((l.entrepotIds || []).slice(0, 1)) : [];
      var planTxt = isInc ? (n.reason === "embauche" ? "Embauche le " + DB.fmtDate(l && l.dateEmbauche) : ctrlTypeLabel(e && e.type)) :
        (e && e.heureDebut ? e.heureDebut + " – " + e.heureFin : "Travail");
      return '<tr>' +
        '<td><strong>' + LM.escapeHtml(ctrlLivreurName(livId)) + '</strong></td>' +
        '<td class="text-sm">' + LM.escapeHtml(entNames[0] || "—") + '</td>' +
        '<td class="text-sm">' + LM.escapeHtml(planTxt) + '</td>' +
        '<td class="actions">' +
          (isInc ? '' :
            '<button type="button" class="btn btn-secondary btn-sm" data-ctrlsaisir="' + livId + '">' + LM.icon("edit") + ' Saisir</button>' +
            '<button type="button" class="btn btn-ghost btn-sm" data-ctrlrepos="' + livId + '" title="Ce livreur n\'a pas travaillé ce jour-là : passer sa case du planning en « Repos »">Pas travaillé</button>') +
        '</td>' +
      '</tr>';
    }).join("");

    LM.openModal({
      title: LM.escapeHtml(t.title),
      wide: true,
      bodyHtml:
        '<div class="ctrl-modal-head" style="--ctrl-color:' + k.color + ';--ctrl-tint:' + k.tint + ';"><span class="ctrl-notif-icon">' + LM.icon(k.icon) + '</span><div><div class="ctrl-notif-chips">' + ctrlChipsHtml(n) + '</div><p class="text-sm" style="margin:8px 0 0;">' + LM.escapeHtml(t.sub) + '</p></div></div>' +
        '<div class="table-wrap" style="margin-top:14px;"><table><thead><tr><th>Livreur</th><th>Entrepôt</th><th>' + (isInc ? "Au planning" : "Prévu") + '</th><th></th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div>' +
        (isInc ? '' : '<p class="hint" style="margin-top:12px;"><strong>Saisir</strong> prépare la ligne dans la saisie manuelle. <strong>Pas travaillé</strong> corrige le planning (case passée en « Repos ») si le livreur n\'était finalement pas là : l\'alerte disparaît.</p>'),
      footerHtml:
        '<button class="btn btn-secondary" id="ctrlCloseBtn">Fermer</button>' +
        '<button class="btn btn-ghost" id="ctrlPlanBtn">' + LM.icon("calendar") + ' Voir le planning</button>' +
        (ign ? '<button class="btn btn-ghost" id="ctrlRestoreBtn">Restaurer l\'alerte</button>' : '<button class="btn btn-ghost" id="ctrlIgnoreBtn">Ignorer</button>') +
        (isInc ? '<button class="btn btn-secondary" id="ctrlEntriesBtn">' + LM.icon("eye") + ' Voir les entrées</button>' +
                 (n.reason === "absence" ? '<button class="btn btn-primary" id="ctrlTravailBtn">Passer en « Travail » au planning</button>' : '') :
                 (n.livreurIds.length > 1 ? '<button class="btn btn-primary" id="ctrlAllBtn">' + LM.icon("edit") + ' Saisir pour les ' + n.livreurIds.length + ' livreurs</button>' : '')),
      onMount: function (modal) {
        function on(id, fn) { var el = modal.querySelector(id); if (el) el.addEventListener("click", fn); }
        on("#ctrlCloseBtn", LM.closeModal);
        on("#ctrlPlanBtn", function () { ctrlOpenPlanning(n.date); });
        on("#ctrlIgnoreBtn", function () { DB.setControleIgnore(n.key, true); LM.closeModal(); LM.toast("Alerte ignorée.", "success"); renderControlCard(); });
        on("#ctrlRestoreBtn", function () { DB.setControleIgnore(n.key, false); LM.closeModal(); renderControlCard(); });
        on("#ctrlEntriesBtn", function () { ctrlShowEntries(n); });
        on("#ctrlAllBtn", function () { ctrlPrefillManual(n, n.livreurIds); });
        on("#ctrlTravailBtn", function () {
          var reg = DB.getPlanningReglages();
          DB.upsertPlanningEntree(n.livreurIds[0], n.date, { type: "travail", heureDebut: reg.heureDebut, heureFin: reg.heureFin, pauseDuree: reg.pauseActive ? reg.pauseDuree : 0, commentaire: "", fromDemande: false });
          LM.closeModal();
          LM.toast("Planning corrigé : " + ctrlLivreurName(n.livreurIds[0]) + " est maintenant en « Travail » le " + DB.fmtDate(n.date) + ".", "success");
          renderControlCard();
        });
        modal.querySelectorAll("[data-ctrlsaisir]").forEach(function (b) {
          b.addEventListener("click", function () { ctrlPrefillManual(n, [b.getAttribute("data-ctrlsaisir")]); });
        });
        modal.querySelectorAll("[data-ctrlrepos]").forEach(function (b) {
          b.addEventListener("click", function () {
            var livId = b.getAttribute("data-ctrlrepos");
            DB.upsertPlanningEntree(livId, n.date, { type: "repos", heureDebut: "", heureFin: "", pauseDuree: 0, commentaire: "", fromDemande: false });
            LM.closeModal();
            LM.toast(ctrlLivreurName(livId) + " passé(e) en « Repos » le " + DB.fmtDate(n.date) + " au planning.", "success");
            renderControlCard();
          });
        });
      }
    });
  }

  // ------------------------------------------------------------------
  // Rendu principal
  // ------------------------------------------------------------------
  function render(content) {
    content.innerHTML =
      '<div class="card">' +
        '<div class="card-header"><div><h2>Période d\'analyse</h2><p>Choisissez une période pour filtrer les statistiques ci-dessous.</p></div>' +
          '<button class="btn btn-pdf" id="btnExportAnalysePdf">' + LM.icon("file") + ' Exporter en PDF</button>' +
        '</div>' +
        '<div class="flex gap-8" style="flex-wrap:wrap;margin-bottom:14px;" id="presetRow"></div>' +
        '<div class="form-row" id="customRow" style="' + (period.preset === "custom" ? "" : "display:none;") + '">' +
          '<div class="field"><label>Du</label><input type="date" id="customStart" value="' + period.start + '" /></div>' +
          '<div class="field"><label>Au</label><input type="date" id="customEnd" value="' + period.end + '" /></div>' +
          '<div class="field" style="align-self:flex-end;"><button class="btn btn-secondary" id="applyCustom">Appliquer</button></div>' +
        '</div>' +
      '</div>' +
      '<div class="grid grid-4" id="kpiRow" style="margin-bottom:22px;"></div>' +
      '<div class="grid grid-2">' +
        '<div class="card"><h3>Livraisons par jour</h3><p class="text-sm">Évolution sur la période sélectionnée.</p><div id="chartLine" style="margin-top:10px;"></div></div>' +
        '<div class="card"><h3>Livraisons &amp; bacs par entrepôt</h3><p class="text-sm">Comparaison entre sites.</p><div id="chartBarEnt" style="margin-top:10px;"></div></div>' +
      '</div>' +
      '<div class="grid grid-2">' +
        '<div class="card"><h3>Répartition des livraisons par entrepôt</h3><p class="text-sm">Part de chaque site sur la période.</p><div id="chartDonut" style="margin-top:10px;"></div></div>' +
        '<div class="card"><h3>Top livreurs</h3><p class="text-sm">Classement par nombre de livraisons.</p><div id="chartBarLiv" style="margin-top:10px;"></div></div>' +
      '</div>' +
      '<div class="card" id="controlCard"></div>' +
      '<div class="card" id="journalCard">' +
        '<div class="card-header"><div><h2>Journal des livraisons</h2><p>Importez un fichier Excel, saisissez des entrées manuelles ou consultez l\'historique.</p></div></div>' +
        '<div class="tabs">' +
          '<button class="tab-btn' + (journalTab === "import" ? " active" : "") + '" data-tab="import">Import Excel</button>' +
          '<button class="tab-btn' + (journalTab === "manuel" ? " active" : "") + '" data-tab="manuel">Saisie manuelle</button>' +
          '<button class="tab-btn' + (journalTab === "historique" ? " active" : "") + '" data-tab="historique">Historique &amp; imports</button>' +
        '</div>' +
        '<div id="journalPanel"></div>' +
      '</div>';

    renderPresetRow();
    renderKpis();
    renderCharts();
    renderControlCard();
    renderJournalTab();

    document.getElementById("btnExportAnalysePdf").addEventListener("click", openExportAnalysePdfModal);

    content.querySelectorAll("[data-tab]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        journalTab = btn.getAttribute("data-tab");
        journalPage = 1;
        selectedIds = {};
        render(content);
      });
    });
  }

  function renderPresetRow() {
    var presets = [
      { key: "7j", label: "7 derniers jours" },
      { key: "30j", label: "30 derniers jours" },
      { key: "90j", label: "90 derniers jours" },
      { key: "mois_courant", label: "Mois en cours" },
      { key: "mois_dernier", label: "Mois dernier" },
      { key: "custom", label: "Période personnalisée" }
    ];
    var row = document.getElementById("presetRow");
    row.innerHTML = presets.map(function (p) {
      return '<button class="btn btn-sm ' + (period.preset === p.key ? "btn-primary" : "btn-secondary") + '" data-preset="' + p.key + '">' + p.label + '</button>';
    }).join("");
    row.querySelectorAll("[data-preset]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var key = btn.getAttribute("data-preset");
        if (key === "custom") {
          period.preset = "custom";
          document.getElementById("customRow").style.display = "";
          renderPresetRow();
          return;
        }
        applyPreset(key);
        renderPresetRow();
        renderKpis();
        renderCharts();
        if (journalTab === "historique") { journalPage = 1; renderJournalTab(); }
      });
    });
    var applyCustomBtn = document.getElementById("applyCustom");
    if (applyCustomBtn) {
      applyCustomBtn.addEventListener("click", function () {
        var s = document.getElementById("customStart").value;
        var e = document.getElementById("customEnd").value;
        if (!s || !e || s > e) { LM.toast("Plage de dates invalide.", "danger"); return; }
        period.preset = "custom"; period.start = s; period.end = e;
        renderKpis();
        renderCharts();
        if (journalTab === "historique") { journalPage = 1; renderJournalTab(); }
      });
    }
  }

  // ------------------------------------------------------------------
  // KPIs
  // ------------------------------------------------------------------
  function sumField(rows, field) { return rows.reduce(function (a, r) { return a + (Number(r[field]) || 0); }, 0); }

  function trendHtml(current, previous) {
    if (!previous) return '<div class="kpi-trend flat">Pas de période de référence</div>';
    var diff = current - previous;
    var pct = previous !== 0 ? Math.round((diff / previous) * 100) : (current > 0 ? 100 : 0);
    var cls = diff > 0 ? "up" : diff < 0 ? "down" : "flat";
    var arrow = diff > 0 ? "▲" : diff < 0 ? "▼" : "→";
    return '<div class="kpi-trend ' + cls + '">' + arrow + ' ' + (pct >= 0 ? "+" : "") + pct + '% vs période précédente</div>';
  }

  function renderKpis() {
    var rows = livraisonsInRange(period.start, period.end);
    var prev = previousPeriodRange();
    var prevRows = livraisonsInRange(prev.start, prev.end);

    var nbLivraisons = sumField(rows, "nbLivraisons");
    var nbBacs = sumField(rows, "nbBacs");
    var km = sumField(rows, "km");
    var incidents = sumField(rows, "incidents");

    var prevLivraisons = sumField(prevRows, "nbLivraisons");
    var prevBacs = sumField(prevRows, "nbBacs");
    var prevKm = sumField(prevRows, "km");
    var prevIncidents = sumField(prevRows, "incidents");

    document.getElementById("kpiRow").innerHTML =
      kpi("truck", "Livraisons", DB.fmtNum(nbLivraisons), trendHtml(nbLivraisons, prevLivraisons)) +
      kpi("box", "Bacs livrés", DB.fmtNum(nbBacs), trendHtml(nbBacs, prevBacs)) +
      kpi("zones", "Kilomètres parcourus", DB.fmtNum(Math.round(km)), trendHtml(km, prevKm)) +
      kpi("alert", "Incidents signalés", DB.fmtNum(incidents), trendHtml(incidents, prevIncidents));
  }

  // ------------------------------------------------------------------
  // Graphiques
  // ------------------------------------------------------------------
  function entrepotLabel(r) { return r.entrepotId ? (DB.entrepotNom(r.entrepotId) || r.entrepotNom || "Entrepôt inconnu") : (r.entrepotNom || "Non renseigné"); }
  function entrepotKey(r) { return r.entrepotId || ("n:" + DB.normalizeStr(r.entrepotNom || "")); }
  function livreurLabel(r) { return r.livreurId ? (DB.livreurNom(r.livreurId) || r.livreurNom || "Livreur inconnu") : (r.livreurNom || "Non renseigné"); }
  function livreurKey(r) { return r.livreurId || ("n:" + DB.normalizeStr(r.livreurNom || "")); }

  function renderCharts() {
    var rows = livraisonsInRange(period.start, period.end);

    // Ligne : livraisons par jour
    var byDay = {};
    rows.forEach(function (r) { byDay[r.date] = (byDay[r.date] || 0) + (Number(r.nbLivraisons) || 0); });
    var days = [];
    var d0 = new Date(period.start), d1 = new Date(period.end);
    for (var d = new Date(d0); d <= d1; d.setDate(d.getDate() + 1)) days.push(d.toISOString().slice(0, 10));
    var lineLabels = days.map(function (iso) { return iso.slice(8, 10) + "/" + iso.slice(5, 7); });
    var lineData = days.map(function (iso) { return byDay[iso] || 0; });
    LMCharts.lineChart(document.getElementById("chartLine"), {
      labels: lineLabels, series: [{ name: "Livraisons", data: lineData }], height: 260
    });

    // Barres groupées par entrepôt : livraisons vs bacs
    var byEnt = {};
    rows.forEach(function (r) {
      var k = entrepotKey(r);
      if (!byEnt[k]) byEnt[k] = { label: entrepotLabel(r), liv: 0, bacs: 0 };
      byEnt[k].liv += Number(r.nbLivraisons) || 0;
      byEnt[k].bacs += Number(r.nbBacs) || 0;
    });
    var entList = Object.keys(byEnt).map(function (k) { return byEnt[k]; }).sort(function (a, b) { return b.liv - a.liv; });
    LMCharts.barChart(document.getElementById("chartBarEnt"), {
      labels: entList.map(function (e) { return e.label; }),
      series: [
        { name: "Livraisons", data: entList.map(function (e) { return e.liv; }) },
        { name: "Bacs", data: entList.map(function (e) { return e.bacs; }) }
      ],
      height: 260
    });

    // Donut : répartition des livraisons par entrepôt
    LMCharts.donutChart(document.getElementById("chartDonut"), {
      data: entList.map(function (e) { return { label: e.label, value: e.liv }; }),
      height: 240
    });

    // Top livreurs
    var byLiv = {};
    rows.forEach(function (r) {
      var k = livreurKey(r);
      if (!byLiv[k]) byLiv[k] = { label: livreurLabel(r), liv: 0 };
      byLiv[k].liv += Number(r.nbLivraisons) || 0;
    });
    var livList = Object.keys(byLiv).map(function (k) { return byLiv[k]; }).sort(function (a, b) { return b.liv - a.liv; }).slice(0, 8);
    LMCharts.barChart(document.getElementById("chartBarLiv"), {
      labels: livList.map(function (l) { return l.label; }),
      series: [{ name: "Livraisons", data: livList.map(function (l) { return l.liv; }) }],
      height: 260
    });
  }

  // Nombre de livraisons en retard sur un ensemble d'entrées, à partir des signalements liés
  // (page Retards), pas du champ générique "incidents" (voir DB.retardPourLivraison).
  function sumRetard(rows) {
    return rows.reduce(function (a, r) {
      var ret = DB.retardPourLivraison(r.id);
      return a + (ret ? (Number(ret.nbLivraisonsRetard) || 0) : 0);
    }, 0);
  }

  // ------------------------------------------------------------------
  // Export PDF : statistiques + détail du journal sur la période choisie, filtrables par
  // entrepôt, livreur et source (manuel / import / démo), avec sections activables.
  // ------------------------------------------------------------------
  var UNASSIGNED = "__non_attribue__";

  function openExportAnalysePdfModal() {
    var entrepots = DB.list("entrepots");
    var livreurs = DB.list("livreurs").slice().sort(function (a, b) { return DB.livreurNomComplet(a).localeCompare(DB.livreurNomComplet(b), "fr"); });
    var hasUnassignedEnt = DB.list("livraisons").some(function (r) { return !r.entrepotId; });
    var hasUnassignedLiv = DB.list("livraisons").some(function (r) { return !r.livreurId; });

    LM.openModal({
      title: "Exporter les statistiques en PDF",
      wide: true,
      bodyHtml:
        '<p class="text-sm text-faint" style="margin-top:0;">Générez un rapport PDF des statistiques de livraison, filtré par période, entrepôt, livreur et source.</p>' +
        '<div class="form-row">' +
          '<div class="field"><label>Du</label><input type="date" id="anaPdfStart" value="' + period.start + '" /></div>' +
          '<div class="field"><label>Au</label><input type="date" id="anaPdfEnd" value="' + period.end + '" /></div>' +
        '</div>' +
        '<div class="form-row">' +
          '<div class="field"><label>Entrepôts à inclure</label><select id="anaPdfEnt" multiple size="6">' +
            entrepots.map(function (e) { return '<option value="' + e.id + '" selected>' + LM.escapeHtml(e.nom) + '</option>'; }).join("") +
            (hasUnassignedEnt ? '<option value="' + UNASSIGNED + '" selected>Non reconnu / non renseigné</option>' : "") +
          '</select><div class="hint">Tous sélectionnés par défaut. Ctrl/Cmd + clic pour affiner.</div></div>' +
          '<div class="field"><label>Livreurs à inclure</label><select id="anaPdfLiv" multiple size="6">' +
            livreurs.map(function (l) { return '<option value="' + l.id + '" selected>' + LM.escapeHtml(DB.livreurNomComplet(l)) + '</option>'; }).join("") +
            (hasUnassignedLiv ? '<option value="' + UNASSIGNED + '" selected>Non renseigné</option>' : "") +
          '</select><div class="hint">Tous sélectionnés par défaut. Ctrl/Cmd + clic pour affiner.</div></div>' +
        '</div>' +
        '<div class="field">' +
          '<label>Sources à inclure</label>' +
          Object.keys(SOURCE_BADGES).map(function (k) {
            return '<label class="checkbox-row" style="margin-bottom:8px;"><input type="checkbox" data-anapdfsource="' + k + '" checked /> ' + SOURCE_BADGES[k].label + '</label>';
          }).join("") +
        '</div>' +
        '<div class="field">' +
          '<label>Sections à inclure</label>' +
          [
            { key: "kpis", label: "Indicateurs clés (KPI)" },
            { key: "entrepots", label: "Répartition par entrepôt" },
            { key: "livreurs", label: "Top livreurs" },
            { key: "detail", label: "Détail des entrées du journal" }
          ].map(function (s) {
            return '<label class="checkbox-row" style="margin-bottom:8px;"><input type="checkbox" data-anapdfsection="' + s.key + '" checked /> ' + s.label + '</label>';
          }).join("") +
        '</div>',
      footerHtml:
        '<button class="btn btn-secondary" id="cancelBtn">Annuler</button>' +
        '<button class="btn btn-pdf" id="anaPdfGo">' + LM.icon("file") + ' Générer le PDF</button>',
      onMount: function (modal) {
        modal.querySelector("#cancelBtn").addEventListener("click", LM.closeModal);
        modal.querySelector("#anaPdfGo").addEventListener("click", function () {
          var start = modal.querySelector("#anaPdfStart").value;
          var end = modal.querySelector("#anaPdfEnd").value;
          if (!start || !end || start > end) { LM.toast("Période invalide.", "danger"); return; }

          var entSelect = modal.querySelector("#anaPdfEnt");
          var entOpts = Array.prototype.slice.call(entSelect.selectedOptions);
          if (!entOpts.length) { LM.toast("Sélectionnez au moins un entrepôt.", "danger"); return; }
          var entSet = {}; entOpts.forEach(function (o) { entSet[o.value] = true; });
          var entTotal = entSelect.options.length;

          var livSelect = modal.querySelector("#anaPdfLiv");
          var livOpts = Array.prototype.slice.call(livSelect.selectedOptions);
          if (!livOpts.length) { LM.toast("Sélectionnez au moins un livreur.", "danger"); return; }
          var livSet = {}; livOpts.forEach(function (o) { livSet[o.value] = true; });
          var livTotal = livSelect.options.length;

          var sources = Array.prototype.slice.call(modal.querySelectorAll("[data-anapdfsource]"))
            .filter(function (cb) { return cb.checked; })
            .map(function (cb) { return cb.getAttribute("data-anapdfsource"); });
          if (!sources.length) { LM.toast("Sélectionnez au moins une source à inclure.", "danger"); return; }

          var sections = {};
          Array.prototype.slice.call(modal.querySelectorAll("[data-anapdfsection]")).forEach(function (cb) {
            sections[cb.getAttribute("data-anapdfsection")] = cb.checked;
          });
          if (!Object.keys(sections).some(function (k) { return sections[k]; })) { LM.toast("Sélectionnez au moins une section à inclure.", "danger"); return; }

          LM.closeModal();
          exportAnalysePdf({
            start: start, end: end,
            entSet: entSet, entTotal: entTotal, entAll: entTotal === entOpts.length,
            livSet: livSet, livTotal: livTotal, livAll: livTotal === livOpts.length,
            sources: sources, sourcesAll: sources.length === Object.keys(SOURCE_BADGES).length,
            sections: sections
          });
        });
      }
    });
  }

  function exportAnalysePdf(f) {
    var rows = livraisonsInRange(f.start, f.end).filter(function (r) {
      var entKey = r.entrepotId || UNASSIGNED;
      var livKey = r.livreurId || UNASSIGNED;
      if (!f.entSet[entKey]) return false;
      if (!f.livSet[livKey]) return false;
      if (f.sources.indexOf(r.source || "manuel") === -1) return false;
      return true;
    });

    var periodeLabel = "Période : " + DB.fmtDate(f.start) + " → " + DB.fmtDate(f.end);
    var entLabel = f.entAll ? "Entrepôts : tous" : "Entrepôts : " + f.entTotal + " sur la sélection";
    var livLabel = f.livAll ? "Livreurs : tous" : "Livreurs : " + f.livTotal + " sur la sélection";
    var sourceLabel = "Sources : " + (f.sourcesAll ? "toutes" : f.sources.map(function (k) { return SOURCE_BADGES[k].label; }).join(", "));
    var subtitle = LM.escapeHtml(periodeLabel + "\n" + entLabel + " — " + livLabel + "\n" + sourceLabel);

    var nbLivraisons = sumField(rows, "nbLivraisons"), nbBacs = sumField(rows, "nbBacs"), km = sumField(rows, "km"), incidents = sumField(rows, "incidents"), retard = sumRetard(rows);

    var body = "";

    if (f.sections.kpis) {
      body += '<div class="pr-kpis">' +
        '<div class="pr-kpi"><div class="pr-kpi-label">Livraisons</div><div class="pr-kpi-value">' + DB.fmtNum(nbLivraisons) + '</div></div>' +
        '<div class="pr-kpi"><div class="pr-kpi-label">Bacs livrés</div><div class="pr-kpi-value">' + DB.fmtNum(nbBacs) + '</div></div>' +
        '<div class="pr-kpi"><div class="pr-kpi-label">Kilomètres parcourus</div><div class="pr-kpi-value">' + DB.fmtNum(Math.round(km)) + '</div></div>' +
        '<div class="pr-kpi"><div class="pr-kpi-label">Retards signalés</div><div class="pr-kpi-value">' + DB.fmtNum(retard) + '</div></div>' +
        '<div class="pr-kpi"><div class="pr-kpi-label">Incidents signalés</div><div class="pr-kpi-value">' + DB.fmtNum(incidents) + '</div></div>' +
      '</div>';
    }

    if (f.sections.entrepots) {
      var byEnt = {};
      rows.forEach(function (r) {
        var k = entrepotKey(r);
        if (!byEnt[k]) byEnt[k] = { label: entrepotLabel(r), liv: 0, bacs: 0, km: 0 };
        byEnt[k].liv += Number(r.nbLivraisons) || 0;
        byEnt[k].bacs += Number(r.nbBacs) || 0;
        byEnt[k].km += Number(r.km) || 0;
      });
      var entList = Object.keys(byEnt).map(function (k) { return byEnt[k]; }).sort(function (a, b) { return b.liv - a.liv; });
      body += '<div class="pr-section-title">Répartition par entrepôt</div>' +
        (entList.length ?
          '<table class="pr-table"><thead><tr><th>Entrepôt</th><th>Livraisons</th><th>Bacs</th><th>Km</th></tr></thead><tbody>' +
            entList.map(function (e) { return '<tr><td>' + LM.escapeHtml(e.label) + '</td><td>' + DB.fmtNum(e.liv) + '</td><td>' + DB.fmtNum(e.bacs) + '</td><td>' + DB.fmtNum(Math.round(e.km)) + '</td></tr>'; }).join("") +
          '</tbody></table>' : '<p class="pr-empty">Aucune donnée sur cette période.</p>');
    }

    if (f.sections.livreurs) {
      var byLiv = {};
      rows.forEach(function (r) {
        var k = livreurKey(r);
        if (!byLiv[k]) byLiv[k] = { label: livreurLabel(r), liv: 0, bacs: 0 };
        byLiv[k].liv += Number(r.nbLivraisons) || 0;
        byLiv[k].bacs += Number(r.nbBacs) || 0;
      });
      var livList = Object.keys(byLiv).map(function (k) { return byLiv[k]; }).sort(function (a, b) { return b.liv - a.liv; });
      body += '<div class="pr-section-title">Top livreurs</div>' +
        (livList.length ?
          '<table class="pr-table"><thead><tr><th>Livreur</th><th>Livraisons</th><th>Bacs</th></tr></thead><tbody>' +
            livList.map(function (l) { return '<tr><td>' + LM.escapeHtml(l.label) + '</td><td>' + DB.fmtNum(l.liv) + '</td><td>' + DB.fmtNum(l.bacs) + '</td></tr>'; }).join("") +
          '</tbody></table>' : '<p class="pr-empty">Aucune donnée sur cette période.</p>');
    }

    if (f.sections.detail) {
      var sorted = rows.slice().sort(function (a, b) { return a.date.localeCompare(b.date); });
      body += '<div class="pr-section-title">Détail des entrées du journal (' + sorted.length + ')</div>' +
        (sorted.length > 500 ? '<p class="pr-desc" style="margin-bottom:8px;">Période étendue : ' + sorted.length + ' entrées listées ci-dessous.</p>' : "") +
        (sorted.length ?
          '<table class="pr-table"><thead><tr><th>Date</th><th>Entrepôt</th><th>Livreur</th><th>Livraisons</th><th>Bacs</th><th>Km</th><th>Retard</th><th>Source</th></tr></thead><tbody>' +
            sorted.map(function (r) {
              var ret = DB.retardPourLivraison(r.id);
              var n = ret ? (Number(ret.nbLivraisonsRetard) || 0) : 0;
              var badge = SOURCE_BADGES[r.source] || SOURCE_BADGES.manuel;
              var badgeCls = { manuel: "pr-badge-info", import: "pr-badge-success", demo: "pr-badge-neutral" };
              return '<tr>' +
                '<td>' + DB.fmtDate(r.date) + '</td>' +
                '<td>' + LM.escapeHtml(entrepotLabel(r)) + '</td>' +
                '<td>' + LM.escapeHtml(livreurLabel(r)) + '</td>' +
                '<td>' + DB.fmtNum(r.nbLivraisons) + '</td>' +
                '<td>' + DB.fmtNum(r.nbBacs) + '</td>' +
                '<td>' + DB.fmtNum(r.km) + '</td>' +
                '<td>' + (n > 0 ? '<span class="pr-badge pr-badge-warning">' + n + '</span>' : '<span class="pr-desc">—</span>') + '</td>' +
                '<td><span class="pr-badge ' + (badgeCls[r.source] || "pr-badge-info") + '">' + badge.label + '</span></td>' +
              '</tr>';
            }).join("") +
          '</tbody></table>' : '<p class="pr-empty">Aucune entrée ne correspond aux filtres sélectionnés.</p>');
    }

    LM.printReport("Statistiques de livraison", body, { subtitle: subtitle });
  }

  // ------------------------------------------------------------------
  // Journal : onglets
  // ------------------------------------------------------------------
  function renderJournalTab() {
    var panel = document.getElementById("journalPanel");
    if (journalTab === "import") renderImportTab(panel);
    else if (journalTab === "manuel") renderManualTab(panel);
    else renderHistoriqueTab(panel);
  }

  // ---------------- Import Excel ----------------
  function renderImportTab(panel) {
    panel.innerHTML =
      '<div style="margin-top:14px;">' +
      '<div class="dropzone" id="dropzone">' + LM.icon("file") +
        '<div><strong>Cliquez ou déposez un fichier Excel (.xlsx)</strong></div>' +
        '<div class="text-sm">La première ligne du fichier doit contenir les en-têtes de colonnes.</div>' +
      '</div>' +
      '<input type="file" id="fileInput" accept=".xlsx" style="display:none" />' +
      '<p class="text-sm icon-inline" style="margin-top:10px;"><a href="modele_import_livraisons.xlsx" download>' + LM.icon("download") + ' Télécharger un modèle de fichier Excel</a></p>' +
      '<div id="importPreview"></div>' +
      '</div>';

    var dropzone = document.getElementById("dropzone");
    var fileInput = document.getElementById("fileInput");
    dropzone.addEventListener("click", function () { fileInput.click(); });
    dropzone.addEventListener("dragover", function (e) { e.preventDefault(); dropzone.classList.add("dragover"); });
    dropzone.addEventListener("dragleave", function () { dropzone.classList.remove("dragover"); });
    dropzone.addEventListener("drop", function (e) {
      e.preventDefault(); dropzone.classList.remove("dragover");
      if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener("change", function (e) { if (e.target.files[0]) handleFile(e.target.files[0]); });

    function handleFile(file) {
      if (!/\.xlsx$/i.test(file.name)) { LM.toast("Merci de sélectionner un fichier .xlsx", "danger"); return; }
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var result = XLSXLite.parseWorkbook(reader.result);
          var rows = result.rows.filter(function (r) { return r && r.some(function (c) { return c !== null && c !== undefined && c !== ""; }); });
          if (rows.length < 2) { LM.toast("Le fichier ne contient pas de données exploitables.", "danger"); return; }
          var headers = rows[0].map(function (h) { return (h || "").toString(); });
          var dataRows = rows.slice(1);
          pendingImport = { fileName: file.name, headers: headers, rows: dataRows, mapping: guessMapping(headers) };
          renderMappingUI();
        } catch (err) {
          console.error(err);
          LM.toast("Impossible de lire ce fichier : " + err.message, "danger");
        }
      };
      reader.onerror = function () { LM.toast("Erreur de lecture du fichier.", "danger"); };
      reader.readAsArrayBuffer(file);
    }

    function guessMapping(headers) {
      var mapping = headers.map(function () { return "ignore"; });
      var used = {};
      headers.forEach(function (h, i) {
        var norm = DB.normalizeStr(h);
        Object.keys(FIELD_SYNONYMS).forEach(function (field) {
          if (used[field]) return;
          var synonyms = FIELD_SYNONYMS[field];
          if (synonyms.indexOf(norm) !== -1 || synonyms.some(function (s) { return norm.indexOf(s) !== -1; })) {
            mapping[i] = field;
            used[field] = true;
          }
        });
      });
      return mapping;
    }

    function renderMappingUI() {
      var preview = document.getElementById("importPreview");
      var fieldOptions = ["ignore", "date", "entrepot", "livreur", "nbBacs", "tournee", "sequence", "client", "numero", "rue", "codePostal", "ville", "incidents", "km", "commentaire"];

      preview.innerHTML =
        '<div class="divider"></div>' +
        '<h3>Correspondance des colonnes</h3>' +
        '<p class="text-sm">Fichier : <strong>' + LM.escapeHtml(pendingImport.fileName) + '</strong> — ' + pendingImport.rows.length + ' ligne(s) détectée(s). Associez chaque colonne à un champ.</p>' +
        '<div class="table-wrap"><table><thead><tr>' +
          pendingImport.headers.map(function (h) { return '<th>' + LM.escapeHtml(h || "(vide)") + '</th>'; }).join("") +
        '</tr><tr>' +
          pendingImport.headers.map(function (h, i) {
            return '<th><select data-map="' + i + '">' +
              fieldOptions.map(function (f) { return '<option value="' + f + '"' + (pendingImport.mapping[i] === f ? " selected" : "") + '>' + FIELD_LABELS[f] + '</option>'; }).join("") +
              '</select></th>';
          }).join("") +
        '</tr></thead><tbody>' +
          pendingImport.rows.slice(0, 5).map(function (row) {
            return '<tr>' + pendingImport.headers.map(function (_, i) { return '<td>' + LM.escapeHtml(row[i] !== undefined && row[i] !== null ? row[i] : "") + '</td>'; }).join("") + '</tr>';
          }).join("") +
        '</tbody></table></div>' +
        '<p class="hint">Aperçu limité aux 5 premières lignes. * champs obligatoires.</p>' +
        '<div class="flex gap-10" style="margin-top:14px;">' +
          '<button class="btn btn-primary" id="btnConfirmImport">' + LM.icon("check") + ' Importer ' + pendingImport.rows.length + ' ligne(s)</button>' +
          '<button class="btn btn-secondary" id="btnCancelImport">Annuler</button>' +
        '</div>';

      preview.querySelectorAll("[data-map]").forEach(function (sel) {
        sel.addEventListener("change", function () {
          pendingImport.mapping[Number(sel.getAttribute("data-map"))] = sel.value;
        });
      });
      document.getElementById("btnCancelImport").addEventListener("click", function () { pendingImport = null; preview.innerHTML = ""; fileInput.value = ""; });
      document.getElementById("btnConfirmImport").addEventListener("click", confirmImport);
    }

    function confirmImport() {
      var mapping = pendingImport.mapping;
      var idxOf = {};
      mapping.forEach(function (f, i) { if (f !== "ignore") idxOf[f] = i; });
      if (idxOf.date === undefined || idxOf.entrepot === undefined) {
        LM.toast("Les champs Date et Entrepôt sont obligatoires.", "danger");
        return;
      }
      var batchId = DB.uid("imp");
      var unmatchedEnt = {}, unmatchedLiv = {};
      var newRecords = [];

      pendingImport.rows.forEach(function (row) {
        var dateRaw = row[idxOf.date];
        var iso = parseDateCell(dateRaw);
        if (!iso) return; // ligne sans date exploitable, ignorée

        var entNomRaw = idxOf.entrepot !== undefined ? (row[idxOf.entrepot] || "").toString().trim() : "";
        var entMatch = DB.resolveEntrepotByName(entNomRaw);
        if (entNomRaw && !entMatch) unmatchedEnt[entNomRaw] = true;

        var livNomRaw = idxOf.livreur !== undefined ? (row[idxOf.livreur] || "").toString().trim() : "";
        var livMatch = livNomRaw ? DB.resolveLivreurByName(livNomRaw) : null;
        if (livNomRaw && !livMatch) unmatchedLiv[livNomRaw] = true;

        // Chaque ligne du fichier = une commande = une livraison (nbLivraisons vaut toujours 1 ici).
        newRecords.push({
          date: iso,
          entrepotId: entMatch ? entMatch.id : null,
          entrepotNom: entNomRaw || null,
          livreurId: livMatch ? livMatch.id : null,
          livreurNom: livNomRaw || null,
          nbLivraisons: 1,
          nbBacs: idxOf.nbBacs !== undefined ? (Number(row[idxOf.nbBacs]) || 0) : 0,
          km: idxOf.km !== undefined ? (Number(row[idxOf.km]) || 0) : 0,
          incidents: idxOf.incidents !== undefined ? (Number(row[idxOf.incidents]) || 0) : 0,
          commentaire: idxOf.commentaire !== undefined ? (row[idxOf.commentaire] || "").toString() : "",
          tournee: idxOf.tournee !== undefined ? (row[idxOf.tournee] || "").toString().trim() : "",
          sequence: idxOf.sequence !== undefined ? (row[idxOf.sequence] || "").toString().trim() : "",
          client: idxOf.client !== undefined ? (row[idxOf.client] || "").toString().trim() : "",
          adresse: [
            idxOf.numero !== undefined ? (row[idxOf.numero] || "").toString().trim() : "",
            idxOf.rue !== undefined ? (row[idxOf.rue] || "").toString().trim() : ""
          ].filter(Boolean).join(" "),
          codePostal: idxOf.codePostal !== undefined ? (row[idxOf.codePostal] || "").toString().trim() : "",
          ville: idxOf.ville !== undefined ? (row[idxOf.ville] || "").toString().trim() : "",
          source: "import",
          importBatchId: batchId
        });
      });

      DB.bulkAdd("livraisons", newRecords);
      var inserted = newRecords.length;
      DB.add("importBatches", { id: batchId, fichier: pendingImport.fileName, date: new Date().toISOString(), nbLignes: inserted });
      DB.logHistorique("Analyse", "ajout", "Import de " + inserted + " livraison(s) depuis " + pendingImport.fileName);

      var msg = inserted + " commande(s)/livraison(s) importée(s).";
      var unmEnt = Object.keys(unmatchedEnt), unmLiv = Object.keys(unmatchedLiv);
      if (unmEnt.length) msg += " " + unmEnt.length + " entrepôt(s) non reconnu(s) (conservés tels quels).";
      if (unmLiv.length) msg += " " + unmLiv.length + " livreur(s) non reconnu(s) (conservés tels quels).";
      LM.toast(msg, "success");

      pendingImport = null;
      render(document.getElementById("content"));
    }
  }

  function parseDateCell(v) {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v === "number") {
      try { return XLSXLite.excelSerialToDate(v).toISOString().slice(0, 10); } catch (e) { return null; }
    }
    var s = v.toString().trim();
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
    if (m) return m[1] + "-" + pad2(m[2]) + "-" + pad2(m[3]);
    m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/.exec(s);
    if (m) return m[3] + "-" + pad2(m[2]) + "-" + pad2(m[1]);
    var d = new Date(s);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    return null;
  }
  function pad2(n) { n = String(n); return n.length < 2 ? "0" + n : n; }

  // ---------------- Saisie manuelle ----------------
  // Principe : deux "palettes" rapides (Dates, Entrepôts) sous forme de chips permettent de générer
  // d'un clic toutes les lignes du produit cartésien dates × entrepôts dans une grille éditable pleine
  // largeur ; chaque ligne garde ensuite ses propres livreur/bacs/livraisons/km/retards/commentaire,
  // et peut être dupliquée (ex : 2 livreurs le même jour au même entrepôt) ou supprimée indépendamment.
  // Un seul clic sur "Enregistrer" crée toutes les entrées en une fois. La colonne "Retards" crée
  // automatiquement, pour chaque ligne où elle est renseignée (> 0), le signalement de retard
  // correspondant (DB.upsertRetard, même mécanisme que le bouton "Gérer le retard" de la page
  // Retards) : la nouvelle entrée du journal apparaît donc immédiatement dans la page Retards, liée
  // par la même date/entrepôt/livreur — libre ensuite d'y préciser les clients concernés et le détail.
  function renderManualTab(panel) {
    var entrepots = DB.list("entrepots");
    panel.innerHTML =
      '<form id="manualForm" style="margin-top:14px;">' +
        '<div class="grid grid-2" style="align-items:start;margin-bottom:16px;">' +
          '<div class="field mb-0">' +
            '<label>1. Dates</label>' +
            '<div class="date-picker-panel">' +
              '<div class="form-row" style="margin-bottom:0;align-items:flex-end;">' +
                '<div class="field mb-0" style="flex:0 0 170px;"><label class="text-sm text-muted" style="margin-bottom:4px;">Ajouter une date</label><input type="date" id="manDateSingle" value="' + DB.todayISO() + '" /></div>' +
                '<div class="field mb-0"><button type="button" class="btn btn-secondary btn-sm" id="btnAddDate">' + LM.icon("plus") + ' Ajouter</button></div>' +
              '</div>' +
              '<div class="divider" style="margin:14px 0;"></div>' +
              '<div class="form-row" style="margin-bottom:0;align-items:flex-end;">' +
                '<div class="field mb-0" style="flex:0 0 130px;"><label class="text-sm text-muted" style="margin-bottom:4px;">Du</label><input type="date" id="manRangeStart" /></div>' +
                '<div class="field mb-0" style="flex:0 0 130px;"><label class="text-sm text-muted" style="margin-bottom:4px;">Au</label><input type="date" id="manRangeEnd" /></div>' +
                '<div class="field mb-0"><div class="checkbox-row" style="height:38px;"><input type="checkbox" id="manSkipSunday" checked /><label for="manSkipSunday">Exclure les dimanches</label></div></div>' +
                '<div class="field mb-0"><button type="button" class="btn btn-secondary btn-sm" id="btnAddRange">' + LM.icon("plus") + ' Plage</button></div>' +
              '</div>' +
              '<div id="manDatesChips" style="margin-top:14px;"></div>' +
            '</div>' +
          '</div>' +
          '<div class="field mb-0" style="display:flex;flex-direction:column;gap:16px;">' +
            '<div>' +
              '<label>2. Entrepôts</label>' +
              '<div class="date-picker-panel">' +
                '<div class="form-row" style="margin-bottom:0;align-items:flex-end;">' +
                  '<div class="field mb-0" style="flex:1;min-width:200px;"><label class="text-sm text-muted" style="margin-bottom:4px;">Ajouter un entrepôt</label><select id="manEntSelect"><option value="">Sélectionner…</option>' +
                    entrepots.map(function (e) { return '<option value="' + e.id + '">' + LM.escapeHtml(e.nom) + '</option>'; }).join("") +
                  '</select></div>' +
                  '<div class="field mb-0"><button type="button" class="btn btn-secondary btn-sm" id="btnAddEnt">' + LM.icon("plus") + ' Ajouter</button></div>' +
                '</div>' +
                '<div id="manEntsChips" style="margin-top:14px;"></div>' +
              '</div>' +
            '</div>' +
            '<div>' +
              '<label>3. Livreurs <span class="text-faint" style="font-weight:500;">(optionnel)</span></label>' +
              '<div class="date-picker-panel">' +
                '<div class="form-row" style="margin-bottom:0;align-items:flex-end;">' +
                  '<div class="field mb-0" style="flex:1;min-width:200px;"><label class="text-sm text-muted" style="margin-bottom:4px;">Pré-sélectionner un livreur</label><select id="manLivSelect"><option value="">Sélectionner…</option></select></div>' +
                  '<div class="field mb-0"><button type="button" class="btn btn-secondary btn-sm" id="btnAddLiv">' + LM.icon("plus") + ' Ajouter</button></div>' +
                '</div>' +
                '<div id="manLivsChips" style="margin-top:14px;"></div>' +
                '<div class="hint" style="margin-top:10px;">Sans sélection, le livreur reste à choisir ligne par ligne dans la grille.</div>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="flex gap-14" style="margin-bottom:18px;align-items:center;flex-wrap:wrap;">' +
          '<button type="button" class="btn btn-primary btn-sm" id="btnGenerateGrid">' + LM.icon("check") + ' Générer les lignes</button>' +
          '<span class="text-sm text-faint">Ajoute une ligne pour chaque combinaison (dates × entrepôts, × livreurs si pré-sélectionnés) non encore présente dans la grille ; ajustez ensuite librement chaque ligne.</span>' +
        '</div>' +
        '<p class="hint" style="margin-top:-8px;">La colonne <strong>Retards</strong> crée automatiquement, pour chaque ligne renseignée, le signalement correspondant dans la page <strong>Retards</strong> (même date, entrepôt et livreur) — vous pourrez ensuite y préciser les clients concernés.</p>' +
        '<div class="table-wrap" style="margin-bottom:16px;"><table><thead><tr>' +
          '<th>Date</th><th>Entrepôt</th><th style="width:190px;">Livreur</th><th class="num" style="width:100px;">Livraisons *</th><th class="num" style="width:90px;">Bacs</th><th class="num" style="width:90px;">Km</th><th class="num" style="width:90px;" title="Crée automatiquement un signalement dans la page Retards">Retards</th><th>Commentaire</th><th style="width:76px;"></th>' +
        '</tr></thead><tbody id="manGridBody"></tbody></table></div>' +
        '<button type="submit" class="btn btn-primary" id="manSubmitBtn"></button>' +
      '</form>';

    manualSync = syncGridFromDom;
    renderDateChips();
    renderEntChips();
    renderLivChips();
    refreshLivSelectOptions();
    renderGridBody();

    document.getElementById("btnAddDate").addEventListener("click", function () {
      var input = document.getElementById("manDateSingle");
      if (!input.value) return;
      if (addManualDate(input.value)) renderDateChips();
      else LM.toast("Cette date est déjà dans la sélection.", "danger");
    });

    document.getElementById("btnAddRange").addEventListener("click", function () {
      var s = document.getElementById("manRangeStart").value;
      var e = document.getElementById("manRangeEnd").value;
      if (!s || !e || s > e) { LM.toast("Plage de dates invalide.", "danger"); return; }
      var skipSunday = document.getElementById("manSkipSunday").checked;
      var added = 0;
      for (var d = new Date(s); d <= new Date(e); d.setDate(d.getDate() + 1)) {
        if (skipSunday && d.getDay() === 0) continue;
        if (addManualDate(d.toISOString().slice(0, 10))) added++;
      }
      renderDateChips();
      if (added) LM.toast(added + " date(s) ajoutée(s) à la sélection.", "success");
      else LM.toast("Toutes les dates de cette plage sont déjà sélectionnées.", "danger");
    });

    document.getElementById("btnAddEnt").addEventListener("click", function () {
      var sel = document.getElementById("manEntSelect");
      if (!sel.value) return;
      if (manualEntrepots.indexOf(sel.value) === -1) {
        manualEntrepots.push(sel.value);
        renderEntChips();
        refreshLivSelectOptions();
      } else {
        LM.toast("Cet entrepôt est déjà dans la sélection.", "danger");
      }
      sel.value = "";
    });

    document.getElementById("btnAddLiv").addEventListener("click", function () {
      var sel = document.getElementById("manLivSelect");
      if (!sel.value) return;
      if (manualLivreurs.indexOf(sel.value) === -1) {
        manualLivreurs.push(sel.value);
        renderLivChips();
      } else {
        LM.toast("Ce livreur est déjà dans la sélection.", "danger");
      }
      sel.value = "";
    });

    document.getElementById("btnGenerateGrid").addEventListener("click", function () {
      if (!manualDates.length || !manualEntrepots.length) { LM.toast("Sélectionnez au moins une date et un entrepôt avant de générer la grille.", "danger"); return; }
      syncGridFromDom();
      var added = 0, skipped = 0;
      manualDates.forEach(function (d) {
        manualEntrepots.forEach(function (entId) {
          if (manualLivreurs.length) {
            manualLivreurs.forEach(function (livId) {
              if (!DB.livreurAEntrepot(DB.get("livreurs", livId), entId)) { skipped++; return; } // livreur non rattaché à cet entrepôt : combinaison ignorée
              var exists = manualGridRows.some(function (r) { return r.date === d && r.entrepotId === entId && r.livreurId === livId; });
              if (!exists) {
                manualGridRows.push({ id: DB.uid("mgr"), date: d, entrepotId: entId, livreurId: livId, nbLivraisons: "", nbBacs: "", km: "", retards: "", commentaire: "" });
                added++;
              }
            });
          } else {
            var exists = manualGridRows.some(function (r) { return r.date === d && r.entrepotId === entId; });
            if (!exists) {
              manualGridRows.push({ id: DB.uid("mgr"), date: d, entrepotId: entId, livreurId: null, nbLivraisons: "", nbBacs: "", km: "", retards: "", commentaire: "" });
              added++;
            }
          }
        });
      });
      renderGridBody();
      var msg = added ? added + " ligne(s) ajoutée(s) à la grille." : "Toutes ces combinaisons sont déjà présentes dans la grille.";
      if (skipped) msg += " " + skipped + " combinaison(s) ignorée(s) (livreur non rattaché à l'entrepôt concerné).";
      LM.toast(msg, added ? "success" : "danger");
    });

    document.getElementById("manualForm").addEventListener("submit", function (e) {
      e.preventDefault();
      trySubmit();
    });

    // ---------------- Dates : chips ----------------
    function addManualDate(iso) {
      if (!iso || manualDates.indexOf(iso) !== -1) return false;
      manualDates.push(iso);
      manualDates.sort();
      return true;
    }

    function renderDateChips() {
      var wrap = document.getElementById("manDatesChips");
      if (!manualDates.length) {
        wrap.innerHTML = '<p class="text-sm text-faint" style="margin:0;">Aucune date sélectionnée pour l\'instant.</p>';
        return;
      }
      wrap.innerHTML =
        '<div class="text-sm" style="margin-bottom:8px;font-weight:700;color:var(--color-text-muted);">' + manualDates.length + ' jour' + (manualDates.length > 1 ? "s" : "") + ' sélectionné' + (manualDates.length > 1 ? "s" : "") + '</div>' +
        '<div class="date-chip-list">' +
          manualDates.map(function (iso) {
            return '<span class="date-chip">' + DB.fmtDate(iso) + '<button type="button" data-rmdate="' + iso + '" title="Retirer cette date">' + LM.icon("close") + '</button></span>';
          }).join("") +
        '</div>';
      wrap.querySelectorAll("[data-rmdate]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var idx = manualDates.indexOf(btn.getAttribute("data-rmdate"));
          if (idx !== -1) manualDates.splice(idx, 1);
          renderDateChips();
        });
      });
    }

    // ---------------- Entrepôts : chips ----------------
    function renderEntChips() {
      var wrap = document.getElementById("manEntsChips");
      if (!manualEntrepots.length) {
        wrap.innerHTML = '<p class="text-sm text-faint" style="margin:0;">Aucun entrepôt sélectionné pour l\'instant.</p>';
        return;
      }
      wrap.innerHTML =
        '<div class="text-sm" style="margin-bottom:8px;font-weight:700;color:var(--color-text-muted);">' + manualEntrepots.length + ' entrepôt' + (manualEntrepots.length > 1 ? "s" : "") + ' sélectionné' + (manualEntrepots.length > 1 ? "s" : "") + '</div>' +
        '<div class="date-chip-list">' +
          manualEntrepots.map(function (id) {
            var ent = DB.get("entrepots", id);
            return '<span class="date-chip">' + LM.escapeHtml(ent ? ent.nom : "Entrepôt supprimé") + '<button type="button" data-rment="' + id + '" title="Retirer cet entrepôt">' + LM.icon("close") + '</button></span>';
          }).join("") +
        '</div>';
      wrap.querySelectorAll("[data-rment]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var idx = manualEntrepots.indexOf(btn.getAttribute("data-rment"));
          if (idx !== -1) manualEntrepots.splice(idx, 1);
          renderEntChips();
          refreshLivSelectOptions();
        });
      });
    }

    // ---------------- Livreurs : chips (pré-sélection optionnelle) ----------------
    // La liste proposée dépend des entrepôts déjà choisis à l'étape 2 (un livreur n'a de sens à
    // pré-sélectionner que s'il est rattaché à au moins un des entrepôts retenus) ; elle est donc
    // reconstruite à chaque ajout/retrait d'entrepôt.
    function refreshLivSelectOptions() {
      var sel = document.getElementById("manLivSelect");
      var btn = document.getElementById("btnAddLiv");
      if (!sel) return;
      if (!manualEntrepots.length) {
        sel.innerHTML = '<option value="">Sélectionnez d\'abord un entrepôt…</option>';
        sel.disabled = true;
        if (btn) btn.disabled = true;
        return;
      }
      var livreurs = DB.list("livreurs").filter(function (l) {
        return manualEntrepots.some(function (entId) { return DB.livreurAEntrepot(l, entId); });
      }).sort(function (a, b) { return DB.livreurNomComplet(a).localeCompare(DB.livreurNomComplet(b), "fr"); });
      sel.disabled = false;
      if (btn) btn.disabled = false;
      sel.innerHTML = '<option value="">Sélectionner…</option>' +
        livreurs.map(function (l) { return '<option value="' + l.id + '">' + LM.escapeHtml(DB.livreurNomComplet(l)) + '</option>'; }).join("");
    }

    function renderLivChips() {
      var wrap = document.getElementById("manLivsChips");
      if (!manualLivreurs.length) {
        wrap.innerHTML = '<p class="text-sm text-faint" style="margin:0;">Aucun livreur pré-sélectionné.</p>';
        return;
      }
      wrap.innerHTML =
        '<div class="text-sm" style="margin-bottom:8px;font-weight:700;color:var(--color-text-muted);">' + manualLivreurs.length + ' livreur' + (manualLivreurs.length > 1 ? "s" : "") + ' pré-sélectionné' + (manualLivreurs.length > 1 ? "s" : "") + '</div>' +
        '<div class="date-chip-list">' +
          manualLivreurs.map(function (id) {
            var l = DB.get("livreurs", id);
            return '<span class="date-chip">' + LM.escapeHtml(l ? DB.livreurNomComplet(l) : "Livreur supprimé") + '<button type="button" data-rmliv="' + id + '" title="Retirer ce livreur">' + LM.icon("close") + '</button></span>';
          }).join("") +
        '</div>';
      wrap.querySelectorAll("[data-rmliv]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var idx = manualLivreurs.indexOf(btn.getAttribute("data-rmliv"));
          if (idx !== -1) manualLivreurs.splice(idx, 1);
          renderLivChips();
        });
      });
    }

    // ---------------- Grille ----------------
    // Relit les valeurs actuellement affichées dans les champs de la grille et les recopie dans
    // manualGridRows : à appeler avant toute mutation structurelle (ajout/duplication/suppression de
    // lignes, ou soumission) pour ne jamais perdre ce que l'utilisateur vient de saisir.
    function syncGridFromDom() {
      var body = document.getElementById("manGridBody");
      if (!body) return;
      manualGridRows.forEach(function (row) {
        var livSel = body.querySelector('[data-field="livreurId"][data-row="' + row.id + '"]');
        var f = function (name) { return body.querySelector('[data-field="' + name + '"][data-row="' + row.id + '"]'); };
        if (livSel) row.livreurId = livSel.value || null;
        ["nbLivraisons", "nbBacs", "km", "retards", "commentaire"].forEach(function (name) {
          var input = f(name);
          if (input) row[name] = input.value;
        });
      });
    }

    function clearRowErrors() {
      document.querySelectorAll(".input-error").forEach(function (el) { el.classList.remove("input-error"); });
    }

    function updateSubmitLabel() {
      var btn = document.getElementById("manSubmitBtn");
      if (!btn) return;
      var n = manualGridRows.length;
      btn.innerHTML = LM.icon("check") + " Enregistrer " + (n ? n + " entrée" + (n > 1 ? "s" : "") : "les entrées");
      btn.disabled = !n;
    }

    function renderGridBody() {
      var body = document.getElementById("manGridBody");
      var sorted = manualGridRows.slice().sort(function (a, b) {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        var an = DB.entrepotNom(a.entrepotId) || "", bn = DB.entrepotNom(b.entrepotId) || "";
        return an.localeCompare(bn, "fr");
      });
      if (!sorted.length) {
        body.innerHTML = '<tr class="empty-row"><td colspan="9">Ajoutez des dates et des entrepôts ci-dessus, puis cliquez sur « Générer les lignes ».</td></tr>';
      } else {
        body.innerHTML = sorted.map(function (row) {
          var livreurs = DB.list("livreurs").filter(function (l) { return DB.livreurAEntrepot(l, row.entrepotId); });
          var val = function (v) { return v !== undefined && v !== null ? v : ""; };
          return '<tr>' +
            '<td class="text-sm" style="white-space:nowrap;">' + DB.fmtDate(row.date) + '</td>' +
            '<td class="text-sm">' + LM.escapeHtml(DB.entrepotNom(row.entrepotId) || "—") + '</td>' +
            '<td><select class="table-input" data-field="livreurId" data-row="' + row.id + '"><option value="">Non précisé</option>' +
              livreurs.map(function (l) { return '<option value="' + l.id + '"' + (l.id === row.livreurId ? " selected" : "") + '>' + LM.escapeHtml(DB.livreurNomComplet(l)) + '</option>'; }).join("") +
            '</select></td>' +
            '<td><input type="number" min="0" class="table-input table-input-num" data-field="nbLivraisons" data-row="' + row.id + '" value="' + val(row.nbLivraisons) + '" /></td>' +
            '<td><input type="number" min="0" class="table-input table-input-num" data-field="nbBacs" data-row="' + row.id + '" value="' + val(row.nbBacs) + '" /></td>' +
            '<td><input type="number" step="0.1" min="0" class="table-input table-input-num" data-field="km" data-row="' + row.id + '" value="' + val(row.km) + '" /></td>' +
            '<td><input type="number" min="0" class="table-input table-input-num" data-field="retards" data-row="' + row.id + '" value="' + val(row.retards) + '" /></td>' +
            '<td><input type="text" class="table-input" data-field="commentaire" data-row="' + row.id + '" value="' + LM.escapeHtml(row.commentaire || "") + '" placeholder="Optionnel" /></td>' +
            '<td class="actions">' +
              '<button type="button" class="btn btn-ghost btn-sm btn-icon" data-duprow="' + row.id + '" title="Dupliquer cette ligne (ex : 2 livreurs le même jour)">' + LM.icon("plus") + '</button>' +
              '<button type="button" class="btn btn-ghost btn-sm btn-icon" data-delrow="' + row.id + '" title="Supprimer cette ligne">' + LM.icon("trash") + '</button>' +
            '</td>' +
          '</tr>';
        }).join("");
      }
      body.querySelectorAll("[data-duprow]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          syncGridFromDom();
          var src = manualGridRows.find(function (r) { return r.id === btn.getAttribute("data-duprow"); });
          if (!src) return;
          manualGridRows.push({ id: DB.uid("mgr"), date: src.date, entrepotId: src.entrepotId, livreurId: null, nbLivraisons: "", nbBacs: "", km: "", retards: "", commentaire: "" });
          renderGridBody();
        });
      });
      body.querySelectorAll("[data-delrow]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          syncGridFromDom();
          var id = btn.getAttribute("data-delrow");
          manualGridRows = manualGridRows.filter(function (r) { return r.id !== id; });
          renderGridBody();
        });
      });
      updateSubmitLabel();
    }

    function trySubmit() {
      syncGridFromDom();
      if (!manualGridRows.length) { LM.toast("Ajoutez au moins une ligne à la grille avant d'enregistrer (dates + entrepôts, puis « Générer les lignes »).", "danger"); return; }
      clearRowErrors();
      var invalid = manualGridRows.filter(function (row) { return row.nbLivraisons === "" || row.nbLivraisons === null || row.nbLivraisons === undefined || isNaN(Number(row.nbLivraisons)); });
      if (invalid.length) {
        invalid.forEach(function (row) {
          var input = document.querySelector('[data-field="nbLivraisons"][data-row="' + row.id + '"]');
          if (input) input.classList.add("input-error");
        });
        LM.toast("Merci de renseigner le nombre de livraisons sur les lignes surlignées en rouge.", "danger");
        return;
      }
      var overRetard = manualGridRows.filter(function (row) {
        var n = Number(row.retards) || 0;
        return n > (Number(row.nbLivraisons) || 0);
      });
      if (overRetard.length) {
        overRetard.forEach(function (row) {
          var input = document.querySelector('[data-field="retards"][data-row="' + row.id + '"]');
          if (input) input.classList.add("input-error");
        });
        LM.toast("Le nombre de retards ne peut pas dépasser le nombre de livraisons sur les lignes surlignées en rouge.", "danger");
        return;
      }
      var records = manualGridRows.map(function (row) {
        var liv = row.livreurId ? DB.get("livreurs", row.livreurId) : null;
        var ent = DB.get("entrepots", row.entrepotId);
        return {
          date: row.date,
          entrepotId: row.entrepotId, entrepotNom: ent ? ent.nom : null,
          livreurId: row.livreurId || null, livreurNom: liv ? DB.livreurNomComplet(liv) : null,
          nbLivraisons: Number(row.nbLivraisons) || 0,
          nbBacs: Number(row.nbBacs) || 0,
          km: Number(row.km) || 0,
          incidents: Number(row.retards) || 0,
          commentaire: (row.commentaire || "").toString().trim(),
          source: "manuel"
        };
      });
      DB.bulkAdd("livraisons", records);
      DB.logHistorique("Analyse", "ajout", records.length > 1 ? "Ajout manuel de " + records.length + " entrées au journal des livraisons" : "Ajout manuel d'une entrée au journal des livraisons");

      // Chaque ligne où "Retards" est renseigné (> 0) crée automatiquement le signalement
      // correspondant (même mécanisme que le bouton "Gérer le retard" de la page Retards), lié à la
      // nouvelle entrée du journal : la page Retards affiche donc immédiatement ce signalement, avec
      // la même date/entrepôt/livreur — les clients concernés restent à préciser depuis cette page.
      var nbAvecRetard = 0;
      records.forEach(function (rec) {
        if (rec.incidents > 0) {
          DB.upsertRetard(rec.id, { nbLivraisonsRetard: rec.incidents });
          nbAvecRetard++;
        }
      });
      if (nbAvecRetard) {
        DB.logHistorique("Retards", "ajout", nbAvecRetard > 1 ?
          "Création automatique de " + nbAvecRetard + " signalements de retard depuis la saisie manuelle (page Analyse)" :
          "Création automatique d'un signalement de retard depuis la saisie manuelle (page Analyse)");
      }

      var msg = records.length > 1 ? records.length + " entrées ajoutées au journal." : "Entrée ajoutée au journal.";
      if (nbAvecRetard) msg += " " + nbAvecRetard + " signalement(s) de retard créé(s) automatiquement.";
      LM.toast(msg, "success");
      manualDates = [DB.todayISO()];
      manualEntrepots = [];
      manualLivreurs = [];
      manualGridRows = [];
      render(document.getElementById("content"));
    }
  }

  // ---------------- Historique ----------------
  var SOURCE_BADGES = { manuel: { label: "Manuel", cls: "badge-info" }, import: { label: "Import", cls: "badge-success" }, demo: { label: "Démo", cls: "badge-muted" } };

  // Applique les filtres locaux (date / entrepôt / livreur) de l'onglet Historique. Le mode de
  // date "toutes" reprend la "Période d'analyse" globale ; "unique"/"periode" la remplacent pour
  // cet onglet uniquement (sans toucher aux KPI/graphiques des autres onglets).
  function historiqueFilteredRows() {
    var base;
    if (histDateMode === "unique" && histDateSingle) {
      base = livraisonsInRange(histDateSingle, histDateSingle);
    } else if (histDateMode === "periode" && histDateStart && histDateEnd) {
      base = livraisonsInRange(histDateStart, histDateEnd);
    } else {
      base = livraisonsInRange(period.start, period.end);
    }
    if (histEntIds) {
      var entSet = {}; histEntIds.forEach(function (id) { entSet[id] = true; });
      base = base.filter(function (r) { return !!entSet[r.entrepotId || UNASSIGNED]; });
    }
    if (histLivIds) {
      var livSet = {}; histLivIds.forEach(function (id) { livSet[id] = true; });
      base = base.filter(function (r) { return !!livSet[r.livreurId || UNASSIGNED]; });
    }
    return base;
  }

  function renderHistoriqueTab(panel) {
    var batches = DB.list("importBatches").slice().reverse();
    var entrepots = DB.list("entrepots");
    var livreurs = DB.list("livreurs").slice().sort(function (a, b) { return DB.livreurNomComplet(a).localeCompare(DB.livreurNomComplet(b), "fr"); });
    var hasUnassignedEnt = DB.list("livraisons").some(function (r) { return !r.entrepotId; });
    var hasUnassignedLiv = DB.list("livraisons").some(function (r) { return !r.livreurId; });
    var all = historiqueFilteredRows().sort(function (a, b) { return b.date.localeCompare(a.date); });
    var totalPages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
    if (journalPage > totalPages) journalPage = totalPages;
    var pageRows = all.slice((journalPage - 1) * PAGE_SIZE, journalPage * PAGE_SIZE);

    // Ne garde en sélection que les entrées encore présentes dans la période/les filtres affichés :
    // évite de supprimer "à l'aveugle" des lignes qui ne sont plus visibles après un changement.
    var allIds = {};
    all.forEach(function (r) { allIds[r.id] = true; });
    Object.keys(selectedIds).forEach(function (id) { if (!allIds[id]) delete selectedIds[id]; });

    var selectedCount = Object.keys(selectedIds).length;
    var pageAllSelected = pageRows.length > 0 && pageRows.every(function (r) { return selectedIds[r.id]; });
    var filtersActive = histDateMode !== "toutes" || histEntIds !== null || histLivIds !== null;

    panel.innerHTML =
      '<div style="margin-top:14px;">' +
      (batches.length ? (
        '<h3>Imports précédents</h3>' +
        '<div class="table-wrap" style="margin-bottom:20px;"><table><thead><tr><th>Fichier</th><th>Date d\'import</th><th class="num">Lignes</th><th></th></tr></thead><tbody>' +
        batches.map(function (b) {
          return '<tr><td>' + LM.escapeHtml(b.fichier) + '</td><td>' + new Date(b.date).toLocaleString("fr-FR") + '</td><td class="num">' + b.nbLignes + '</td>' +
            '<td class="actions"><button class="btn btn-ghost btn-sm" data-undo="' + b.id + '">Annuler cet import</button></td></tr>';
        }).join("") + '</tbody></table></div>'
      ) : "") +
      '<div class="card" style="margin-bottom:18px;">' +
        '<div class="flex-between" style="margin-bottom:4px;">' +
          '<h3 style="margin:0;">Filtrer le journal</h3>' +
          (filtersActive ? '<button type="button" class="text-link" id="histFilterResetBtn">Réinitialiser les filtres</button>' : "") +
        '</div>' +
        '<div class="form-row" style="align-items:flex-end;">' +
          '<div class="field mb-0"><label>Trier / filtrer par date</label><select id="histDateModeSelect">' +
            '<option value="toutes"' + (histDateMode === "toutes" ? " selected" : "") + '>Période d\'analyse sélectionnée ci-dessus</option>' +
            '<option value="unique"' + (histDateMode === "unique" ? " selected" : "") + '>Une date précise</option>' +
            '<option value="periode"' + (histDateMode === "periode" ? " selected" : "") + '>Une période personnalisée</option>' +
          '</select></div>' +
          (histDateMode === "unique" ?
            '<div class="field mb-0"><label>Date</label><input type="date" id="histDateSingleInput" value="' + (histDateSingle || "") + '" /></div>'
            : "") +
          (histDateMode === "periode" ?
            '<div class="field mb-0"><label>Du</label><input type="date" id="histDateStartInput" value="' + (histDateStart || "") + '" /></div>' +
            '<div class="field mb-0"><label>Au</label><input type="date" id="histDateEndInput" value="' + (histDateEnd || "") + '" /></div>'
            : "") +
          (histDateMode !== "toutes" ? '<div class="field mb-0"><button type="button" class="btn btn-secondary btn-sm" id="histDateApplyBtn">Appliquer</button></div>' : "") +
        '</div>' +
        '<div class="form-row">' +
          '<div class="field mb-0"><label>Entrepôt(s)</label><select id="histEntFilter" multiple size="4">' +
            entrepots.map(function (e) {
              var sel = histEntIds === null || histEntIds.indexOf(e.id) !== -1;
              return '<option value="' + e.id + '"' + (sel ? " selected" : "") + '>' + LM.escapeHtml(e.nom) + '</option>';
            }).join("") +
            (hasUnassignedEnt ? '<option value="' + UNASSIGNED + '"' + ((histEntIds === null || histEntIds.indexOf(UNASSIGNED) !== -1) ? " selected" : "") + '>Non reconnu / non renseigné</option>' : "") +
          '</select><div class="hint">Tous sélectionnés par défaut. Ctrl/Cmd + clic pour affiner.</div></div>' +
          '<div class="field mb-0"><label>Livreur(s)</label><select id="histLivFilter" multiple size="4">' +
            livreurs.map(function (l) {
              var sel = histLivIds === null || histLivIds.indexOf(l.id) !== -1;
              return '<option value="' + l.id + '"' + (sel ? " selected" : "") + '>' + LM.escapeHtml(DB.livreurNomComplet(l)) + '</option>';
            }).join("") +
            (hasUnassignedLiv ? '<option value="' + UNASSIGNED + '"' + ((histLivIds === null || histLivIds.indexOf(UNASSIGNED) !== -1) ? " selected" : "") + '>Non renseigné</option>' : "") +
          '</select><div class="hint">Tous sélectionnés par défaut. Ctrl/Cmd + clic pour affiner.</div></div>' +
        '</div>' +
      '</div>' +
      '<h3>Journal (' + all.length + ' entrée(s)' + (filtersActive ? " filtrée(s)" : " sur la période") + ')</h3>' +
      '<div class="table-toolbar' + (selectedCount > 0 ? " has-selection" : "") + '">' +
        '<label class="select-all-label' + (pageRows.length ? "" : " disabled") + '">' +
          '<input type="checkbox" id="selectAllRows"' + (pageAllSelected ? " checked" : "") + (pageRows.length ? "" : " disabled") + ' />' +
          '<span>Tout sélectionner (page)</span>' +
        '</label>' +
        (selectedCount > 0 ?
          '<div class="selection-actions">' +
            '<span class="selection-count">' + selectedCount + ' sélectionnée(s)</span>' +
            '<button type="button" class="text-link" id="btnClearSelection">Désélectionner</button>' +
            '<button type="button" class="btn btn-danger btn-sm" id="btnDeleteSelection">' + LM.icon("trash") + ' Supprimer la sélection</button>' +
          '</div>' : "") +
      '</div>' +
      '<div class="table-wrap"><table><thead><tr>' +
        '<th style="width:34px;"></th>' +
        '<th>Date</th><th>Entrepôt</th><th>Livreur</th><th class="num">Livraisons</th><th class="num">Bacs</th><th class="num">Km</th><th class="num">Incidents</th><th>Source</th><th></th>' +
      '</tr></thead><tbody id="histBody"></tbody></table></div>' +
      '<div class="flex gap-10" style="margin-top:14px;align-items:center;justify-content:flex-end;">' +
        '<button class="btn btn-secondary btn-sm" id="prevPage"' + (journalPage <= 1 ? " disabled" : "") + '>Précédent</button>' +
        '<span class="text-sm">Page ' + journalPage + ' / ' + totalPages + '</span>' +
        '<button class="btn btn-secondary btn-sm" id="nextPage"' + (journalPage >= totalPages ? " disabled" : "") + '>Suivant</button>' +
      '</div>' +
      '</div>';

    var histBody = document.getElementById("histBody");
    if (!pageRows.length) {
      histBody.innerHTML = '<tr class="empty-row"><td colspan="10">Aucune entrée sur cette période.</td></tr>';
    } else {
      histBody.innerHTML = pageRows.map(function (r) {
        var badge = SOURCE_BADGES[r.source] || SOURCE_BADGES.manuel;
        return '<tr>' +
          '<td><input type="checkbox" data-select-row="' + r.id + '"' + (selectedIds[r.id] ? " checked" : "") + ' /></td>' +
          '<td>' + DB.fmtDate(r.date) + '</td>' +
          '<td>' + LM.escapeHtml(entrepotLabel(r)) + '</td>' +
          '<td>' + LM.escapeHtml(livreurLabel(r)) + '</td>' +
          '<td class="num">' + DB.fmtNum(r.nbLivraisons) + '</td>' +
          '<td class="num">' + DB.fmtNum(r.nbBacs) + '</td>' +
          '<td class="num">' + DB.fmtNum(r.km) + '</td>' +
          '<td class="num">' + DB.fmtNum(r.incidents) + '</td>' +
          '<td><span class="badge ' + badge.cls + '">' + badge.label + '</span></td>' +
          '<td class="actions">' +
            '<button class="btn btn-ghost btn-sm btn-icon" data-view="' + r.id + '" title="Voir le détail">' + LM.icon("eye") + '</button>' +
            '<button class="btn btn-ghost btn-sm btn-icon" data-del="' + r.id + '" title="Supprimer">' + LM.icon("trash") + '</button>' +
          '</td>' +
        '</tr>';
      }).join("");
      histBody.querySelectorAll("[data-view]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var r = DB.get("livraisons", btn.getAttribute("data-view"));
          if (r) openLivraisonDetailModal(r, function () { render(document.getElementById("content")); });
        });
      });
      histBody.querySelectorAll("[data-del]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var id = btn.getAttribute("data-del");
          LM.confirmDialog("Supprimer cette entrée du journal ?", function () {
            DB.remove("livraisons", id);
            delete selectedIds[id];
            LM.toast("Entrée supprimée.", "success");
            render(document.getElementById("content"));
          });
        });
      });
      histBody.querySelectorAll("[data-select-row]").forEach(function (cb) {
        cb.addEventListener("change", function () {
          var id = cb.getAttribute("data-select-row");
          if (cb.checked) selectedIds[id] = true; else delete selectedIds[id];
          renderJournalTab();
        });
      });
    }

    var selectAllRows = document.getElementById("selectAllRows");
    if (selectAllRows) {
      selectAllRows.addEventListener("change", function () {
        pageRows.forEach(function (r) {
          if (selectAllRows.checked) selectedIds[r.id] = true; else delete selectedIds[r.id];
        });
        renderJournalTab();
      });
    }

    var btnClearSelection = document.getElementById("btnClearSelection");
    if (btnClearSelection) {
      btnClearSelection.addEventListener("click", function () {
        selectedIds = {};
        renderJournalTab();
      });
    }

    var btnDeleteSelection = document.getElementById("btnDeleteSelection");
    if (btnDeleteSelection) {
      btnDeleteSelection.addEventListener("click", function () {
        var ids = Object.keys(selectedIds);
        if (!ids.length) return;
        var rowsToDelete = all.filter(function (r) { return selectedIds[r.id]; });
        var dates = rowsToDelete.map(function (r) { return r.date; }).sort();
        var rangeMsg = dates.length ? (" du " + DB.fmtDate(dates[0]) + " au " + DB.fmtDate(dates[dates.length - 1])) : "";
        LM.confirmDialog(
          "Supprimer définitivement <strong>" + ids.length + " entrée(s)</strong> du journal" + rangeMsg + " ? Cette action est irréversible.",
          function () {
            var removed = DB.bulkRemove("livraisons", ids);
            selectedIds = {};
            DB.logHistorique("Analyse", "suppression", "Suppression de " + removed + " entrée(s) du journal des livraisons" + rangeMsg);
            LM.toast(removed + " entrée(s) supprimée(s).", "success");
            render(document.getElementById("content"));
          }
        );
      });
    }

    panel.querySelectorAll("[data-undo]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-undo");
        LM.confirmDialog("Annuler cet import supprimera toutes les lignes qu'il a créées. Continuer ?", function () {
          var data = DB.getData();
          var batch = data.importBatches.filter(function (b) { return b.id === id; })[0];
          data.livraisons = data.livraisons.filter(function (r) { return r.importBatchId !== id; });
          data.importBatches = data.importBatches.filter(function (b) { return b.id !== id; });
          DB.save();
          DB.logHistorique("Analyse", "suppression", "Annulation de l'import " + (batch ? batch.fichier : id) + (batch ? " (" + batch.nbLignes + " ligne(s))" : ""));
          LM.toast("Import annulé.", "success");
          render(document.getElementById("content"));
        });
      });
    });

    var prevBtn = document.getElementById("prevPage"), nextBtn = document.getElementById("nextPage");
    if (prevBtn) prevBtn.addEventListener("click", function () { journalPage--; renderJournalTab(); });
    if (nextBtn) nextBtn.addEventListener("click", function () { journalPage++; renderJournalTab(); });

    var histDateModeSelect = document.getElementById("histDateModeSelect");
    if (histDateModeSelect) {
      histDateModeSelect.addEventListener("change", function () {
        histDateMode = histDateModeSelect.value;
        journalPage = 1;
        renderJournalTab();
      });
    }
    var histDateApplyBtn = document.getElementById("histDateApplyBtn");
    if (histDateApplyBtn) {
      histDateApplyBtn.addEventListener("click", function () {
        if (histDateMode === "unique") {
          var v = document.getElementById("histDateSingleInput").value;
          if (!v) { LM.toast("Merci de choisir une date.", "danger"); return; }
          histDateSingle = v;
        } else if (histDateMode === "periode") {
          var s = document.getElementById("histDateStartInput").value;
          var e = document.getElementById("histDateEndInput").value;
          if (!s || !e || s > e) { LM.toast("Plage de dates invalide.", "danger"); return; }
          histDateStart = s; histDateEnd = e;
        }
        journalPage = 1;
        renderJournalTab();
      });
    }
    var histEntFilter = document.getElementById("histEntFilter");
    if (histEntFilter) {
      histEntFilter.addEventListener("change", function () {
        var opts = Array.prototype.slice.call(histEntFilter.selectedOptions).map(function (o) { return o.value; });
        histEntIds = (opts.length === histEntFilter.options.length) ? null : opts;
        journalPage = 1;
        renderJournalTab();
      });
    }
    var histLivFilter = document.getElementById("histLivFilter");
    if (histLivFilter) {
      histLivFilter.addEventListener("change", function () {
        var opts = Array.prototype.slice.call(histLivFilter.selectedOptions).map(function (o) { return o.value; });
        histLivIds = (opts.length === histLivFilter.options.length) ? null : opts;
        journalPage = 1;
        renderJournalTab();
      });
    }
    var histFilterResetBtn = document.getElementById("histFilterResetBtn");
    if (histFilterResetBtn) {
      histFilterResetBtn.addEventListener("click", function () {
        histDateMode = "toutes"; histDateSingle = DB.todayISO(); histDateStart = null; histDateEnd = null;
        histEntIds = null; histLivIds = null;
        journalPage = 1;
        renderJournalTab();
      });
    }
  }

  function kpi(iconName, label, value, extraHtml) {
    return '<div class="kpi"><div class="kpi-label"><span class="kpi-icon">' + LM.icon(iconName) + '</span>' + label + '</div><div class="kpi-value">' + value + '</div>' + (extraHtml || "") + '</div>';
  }

  function miniStat(label, value) {
    return '<div><div class="text-sm text-faint">' + label + '</div><div style="font-weight:700;font-size:1.05rem;">' + value + '</div></div>';
  }

  // ------------------------------------------------------------------
  // Fiche détaillée d'une entrée du journal ("Voir") : pop-up à onglets permettant de
  // modifier l'entrée, de gérer les primes ponctuelles du livreur pour cette journée et de
  // consulter un récapitulatif de l'activité de la journée tous entrepôts confondus.
  // Exposée via window.LMApp.openLivraisonDetail pour être réutilisée par d'autres pages
  // (ex : Performance livreurs) sans dépendre du render() propre à cette page : l'appelant
  // fournit son propre callback onChange plutôt que de coder en dur un rafraîchissement.
  // ------------------------------------------------------------------
  function openLivraisonDetailModal(record, onChange) {
    if (!record) return;
    var activeTab = "info";
    var modalRef = null;

    LM.openModal({
      title: "Détail de la livraison — " + DB.fmtDate(record.date),
      wide: true,
      bodyHtml:
        '<div class="tabs">' +
          '<button type="button" class="tab-btn active" data-dtab="info">Informations</button>' +
          '<button type="button" class="tab-btn" data-dtab="primes">Primes</button>' +
          '<button type="button" class="tab-btn" data-dtab="recap">Récapitulatif du jour</button>' +
        '</div>' +
        '<div id="detailPanel"></div>',
      onMount: function (modal) {
        modalRef = modal;
        modal.querySelectorAll("[data-dtab]").forEach(function (tabBtn) {
          tabBtn.addEventListener("click", function () {
            activeTab = tabBtn.getAttribute("data-dtab");
            modal.querySelectorAll("[data-dtab]").forEach(function (b) { b.classList.toggle("active", b === tabBtn); });
            renderActivePanel();
          });
        });
        renderActivePanel();
      }
    });

    function refreshAfterChange() {
      record = DB.get("livraisons", record.id) || record;
      if (typeof onChange === "function") onChange();
    }

    function renderActivePanel() {
      if (!modalRef) return;
      var panel = modalRef.querySelector("#detailPanel");
      if (!panel) return; // la modale a été fermée entre temps
      if (activeTab === "info") renderInfoTab(panel);
      else if (activeTab === "primes") renderPrimesTab(panel);
      else renderRecapTab(panel);
    }

    // ---------------- Onglet Informations ----------------
    function renderInfoTab(panel) {
      var entrepots = DB.list("entrepots");
      var livreurs = DB.list("livreurs");
      var badge = SOURCE_BADGES[record.source] || SOURCE_BADGES.manuel;
      var extras = [
        record.tournee ? "Tournée " + LM.escapeHtml(record.tournee) : "",
        record.sequence ? "séq. " + LM.escapeHtml(record.sequence) : "",
        record.client ? LM.escapeHtml(record.client) : "",
        [record.adresse, record.codePostal, record.ville].filter(Boolean).map(function (s) { return LM.escapeHtml(s); }).join(" ")
      ].filter(Boolean).join(" — ");
      // Le champ "Retards" reflète et met à jour le signalement lié (DB.retardPourLivraison), pas le
      // simple champ historique "incidents" : s'il existe déjà un signalement (ex : créé/complété
      // depuis la page Retards avec ses clients concernés), on affiche et on ne touche qu'à son
      // nombre — les clients/commentaire du signalement restent inchangés.
      var existingRetard = DB.retardPourLivraison(record.id);
      var retardsVal = existingRetard ? (Number(existingRetard.nbLivraisonsRetard) || 0) : (Number(record.incidents) || 0);
      var aucunRetardVal = !!(existingRetard && existingRetard.aucunRetard);

      panel.innerHTML =
        '<div style="margin-top:14px;">' +
        '<p class="text-sm icon-inline">Source : <span class="badge ' + badge.cls + '">' + badge.label + '</span></p>' +
        '<form id="detailInfoForm">' +
          '<div class="form-row">' +
            '<div class="field"><label>Date *</label><input type="date" name="date" value="' + record.date + '" required /></div>' +
            '<div class="field"><label>Entrepôt *</label><select name="entrepotId" required><option value="">Sélectionner…</option>' +
              entrepots.map(function (e) { return '<option value="' + e.id + '"' + (e.id === record.entrepotId ? " selected" : "") + '>' + LM.escapeHtml(e.nom) + '</option>'; }).join("") +
            '</select>' + (!record.entrepotId && record.entrepotNom ? '<div class="hint">Nom brut importé : « ' + LM.escapeHtml(record.entrepotNom) + ' » (non reconnu)</div>' : '') + '</div>' +
            '<div class="field"><label>Livreur</label><select name="livreurId"><option value="">Non précisé</option>' +
              livreurs.map(function (l) { return '<option value="' + l.id + '"' + (l.id === record.livreurId ? " selected" : "") + '>' + LM.escapeHtml(DB.livreurNomComplet(l)) + '</option>'; }).join("") +
            '</select>' + (!record.livreurId && record.livreurNom ? '<div class="hint">Nom brut importé : « ' + LM.escapeHtml(record.livreurNom) + ' » (non reconnu)</div>' : '') + '</div>' +
          '</div>' +
          '<div class="form-row">' +
            '<div class="field"><label>Nb livraisons *</label><input type="number" min="0" name="nbLivraisons" value="' + (record.nbLivraisons || 0) + '" required /></div>' +
            '<div class="field"><label>Nb bacs</label><input type="number" min="0" name="nbBacs" value="' + (record.nbBacs || 0) + '" /></div>' +
            '<div class="field"><label>Km parcourus</label><input type="number" step="0.1" min="0" name="km" value="' + (record.km || 0) + '" /></div>' +
            '<div class="field"><label>Retards</label><input type="number" min="0" name="retards" id="detailRetardsInput" value="' + retardsVal + '"' + (aucunRetardVal ? " disabled" : "") + ' />' +
              '<label class="checkbox-row" style="margin-top:8px;"><input type="checkbox" name="aucunRetard" id="detailAucunRetardCb"' + (aucunRetardVal ? " checked" : "") + ' /><span>Aucun retard sur cette entrée</span></label>' +
              '<div class="hint">Lié à la page Retards : ' + (aucunRetardVal ? "entrée marquée comme étudiée, sans retard." : (existingRetard ? "mis à jour ici, les clients concernés déjà renseignés sont conservés." : "un signalement y sera créé.")) + '</div>' +
            '</div>' +
          '</div>' +
          '<div class="field"><label>Commentaire</label><textarea name="commentaire">' + LM.escapeHtml(record.commentaire || "") + '</textarea></div>' +
          (extras ? '<div class="divider"></div><p class="text-sm text-faint">Informations complémentaires de l\'import (non modifiables) : ' + extras + '</p>' : "") +
          '<button type="submit" class="btn btn-primary">' + LM.icon("check") + ' Enregistrer les modifications</button>' +
        '</form>' +
        '</div>';

      var detailRetardsInput = panel.querySelector("#detailRetardsInput");
      var detailAucunRetardCb = panel.querySelector("#detailAucunRetardCb");
      detailAucunRetardCb.addEventListener("change", function () {
        detailRetardsInput.disabled = detailAucunRetardCb.checked;
        if (detailAucunRetardCb.checked) detailRetardsInput.value = "0";
      });

      panel.querySelector("#detailInfoForm").addEventListener("submit", function (e) {
        e.preventDefault();
        var fd = new FormData(e.target);
        var entId = fd.get("entrepotId");
        if (!entId || !fd.get("date") || !fd.get("nbLivraisons")) { LM.toast("Merci de renseigner les champs obligatoires.", "danger"); return; }
        var nbLivraisons = Number(fd.get("nbLivraisons")) || 0;
        var aucunRetard = detailAucunRetardCb.checked;
        var nRetard = 0;
        if (!aucunRetard) {
          nRetard = Number(fd.get("retards"));
          if (!isFinite(nRetard) || nRetard < 0) nRetard = 0;
          if (nRetard > nbLivraisons) { LM.toast("Le nombre de retards ne peut pas dépasser le nombre de livraisons (" + nbLivraisons + ").", "danger"); return; }
        }
        var ent = DB.get("entrepots", entId);
        var livId = fd.get("livreurId") || null;
        var liv = livId ? DB.get("livreurs", livId) : null;
        DB.update("livraisons", record.id, {
          date: fd.get("date"),
          entrepotId: entId, entrepotNom: ent ? ent.nom : record.entrepotNom,
          livreurId: livId, livreurNom: liv ? DB.livreurNomComplet(liv) : record.livreurNom,
          nbLivraisons: nbLivraisons,
          nbBacs: Number(fd.get("nbBacs")) || 0,
          km: Number(fd.get("km")) || 0,
          incidents: nRetard,
          commentaire: (fd.get("commentaire") || "").toString().trim()
        });
        var hadRetard = !!DB.retardPourLivraison(record.id);
        if (hadRetard || nRetard > 0 || aucunRetard) {
          DB.upsertRetard(record.id, { nbLivraisonsRetard: nRetard, aucunRetard: aucunRetard });
          DB.logHistorique("Retards", hadRetard ? "modification" : "ajout", (hadRetard ? "Modification" : "Ajout") + " signalement de retard : livraison du " + DB.fmtDate(fd.get("date")) + " (" + (liv ? DB.livreurNomComplet(liv) : "livreur non précisé") + ") -> " + (aucunRetard ? "aucun retard" : (nRetard + " en retard")));
        }
        LM.toast("Entrée mise à jour.", "success");
        refreshAfterChange();
        renderActivePanel();
      });
    }

    // ---------------- Onglet Primes ----------------
    function renderPrimesTab(panel) {
      if (!record.livreurId) {
        panel.innerHTML =
          '<div class="empty-state" style="margin-top:14px;">' + LM.icon("primes") +
            '<h3>Aucun livreur rattaché</h3>' +
            '<p class="text-sm">Renseignez un livreur reconnu dans l\'onglet <strong>Informations</strong> pour gérer les primes de cette journée.</p>' +
          '</div>';
        return;
      }
      var liv = DB.get("livreurs", record.livreurId);
      var nomLivreur = liv ? DB.livreurNomComplet(liv) : (record.livreurNom || "Livreur");
      var day = DB.computePrimePeriode(record.livreurId, record.date, record.date);
      var allAdj = DB.list("primesAjustements").filter(function (a) { return a.livreurId === record.livreurId; })
        .slice().sort(function (a, b) { return (b.periodeDebut || "").localeCompare(a.periodeDebut || ""); });

      panel.innerHTML =
        '<div style="margin-top:14px;">' +
        '<div class="card" style="background:var(--color-surface-alt);margin-bottom:18px;">' +
          '<h3 style="margin-top:0;">Prime possible — ' + LM.escapeHtml(nomLivreur) + ' — ' + DB.fmtDate(record.date) + '</h3>' +
          '<div class="grid grid-4">' +
            miniStat("Bacs livrés ce jour", DB.fmtNum(day.bacs)) +
            miniStat("Palier atteint", day.tierLabel !== "Aucun" ? day.tierLabel.replace(/\s*\(\d+j\)/, "") : "Aucun") +
            miniStat("Prime barème du jour", DB.fmtEUR(day.bareme)) +
            miniStat("Primes ponctuelles déjà ajoutées", DB.fmtEUR(day.ajustement)) +
          '</div>' +
        '</div>' +
        '<h3>Ajouter une prime ponctuelle pour cette journée</h3>' +
        '<form id="addPrimeForm" class="form-row" style="align-items:flex-end;">' +
          '<div class="field mb-0"><label>Montant (€) — positif = bonus, négatif = malus *</label><input type="number" step="0.01" name="montant" required /></div>' +
          '<div class="field mb-0" style="flex:2;"><label>Motif</label><input type="text" name="motif" placeholder="ex : renfort le week-end, retard non justifié…" /></div>' +
          '<div class="field mb-0"><button type="submit" class="btn btn-primary">' + LM.icon("plus") + ' Ajouter</button></div>' +
        '</form>' +
        '<div class="divider"></div>' +
        '<h3>Historique des primes ponctuelles de ce livreur (' + allAdj.length + ')</h3>' +
        '<div class="table-wrap"><table><thead><tr><th>Période</th><th class="num">Montant</th><th>Motif</th><th></th></tr></thead><tbody id="adjHistBody"></tbody></table></div>' +
        '</div>';

      panel.querySelector("#addPrimeForm").addEventListener("submit", function (e) {
        e.preventDefault();
        var fd = new FormData(e.target);
        var montant = Number(fd.get("montant"));
        if (!montant) { LM.toast("Merci de renseigner un montant non nul.", "danger"); return; }
        DB.add("primesAjustements", {
          livreurId: record.livreurId,
          periodeDebut: record.date, periodeFin: record.date,
          montant: montant, motif: (fd.get("motif") || "").toString().trim()
        });
        DB.logHistorique("Primes", "ajout", "Ajout prime ponctuelle : " + nomLivreur + " (" + DB.fmtDate(record.date) + ") : " + (montant > 0 ? "+" : "") + DB.fmtEUR(montant));
        LM.toast("Prime ponctuelle ajoutée.", "success");
        if (typeof onChange === "function") onChange();
        renderActivePanel();
      });

      var histBody = panel.querySelector("#adjHistBody");
      if (!allAdj.length) {
        histBody.innerHTML = '<tr class="empty-row"><td colspan="4">Aucun ajustement manuel pour ce livreur.</td></tr>';
      } else {
        histBody.innerHTML = allAdj.map(function (a) {
          var periodeStr = a.periodeDebut === a.periodeFin ? DB.fmtDate(a.periodeDebut) : (DB.fmtDate(a.periodeDebut) + " → " + DB.fmtDate(a.periodeFin));
          return '<tr>' +
            '<td class="text-sm">' + periodeStr + '</td>' +
            '<td class="num">' + (a.montant > 0 ? "+" : "") + DB.fmtEUR(a.montant) + '</td>' +
            '<td class="text-sm">' + (a.motif ? LM.escapeHtml(a.motif) : '<span class="text-faint">—</span>') + '</td>' +
            '<td class="actions"><button class="btn btn-ghost btn-sm btn-icon" data-deladj="' + a.id + '" title="Supprimer">' + LM.icon("trash") + '</button></td>' +
          '</tr>';
        }).join("");
        histBody.querySelectorAll("[data-deladj]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var id = btn.getAttribute("data-deladj");
            LM.confirmDialog("Supprimer cet ajustement de prime ?", function () {
              DB.remove("primesAjustements", id);
              DB.logHistorique("Primes", "suppression", "Suppression prime ponctuelle : " + nomLivreur + " (" + DB.fmtDate(record.date) + ")");
              LM.toast("Ajustement supprimé.", "success");
              if (typeof onChange === "function") onChange();
              renderActivePanel();
            });
          });
        });
      }
    }

    // ---------------- Onglet Récapitulatif du jour ----------------
    function renderRecapTab(panel) {
      var dayRows = DB.list("livraisons").filter(function (r) { return r.date === record.date; });
      var totalLiv = sumField(dayRows, "nbLivraisons");
      var totalBacs = sumField(dayRows, "nbBacs");
      var totalKm = sumField(dayRows, "km");
      var totalInc = sumField(dayRows, "incidents");

      var byEnt = {};
      dayRows.forEach(function (r) {
        var k = entrepotKey(r);
        if (!byEnt[k]) byEnt[k] = { label: entrepotLabel(r), liv: 0, bacs: 0, km: 0, incidents: 0, livreurs: {} };
        byEnt[k].liv += Number(r.nbLivraisons) || 0;
        byEnt[k].bacs += Number(r.nbBacs) || 0;
        byEnt[k].km += Number(r.km) || 0;
        byEnt[k].incidents += Number(r.incidents) || 0;
        byEnt[k].livreurs[livreurKey(r)] = true;
      });
      var entList = Object.keys(byEnt).map(function (k) { return byEnt[k]; }).sort(function (a, b) { return b.liv - a.liv; });

      var primeCardHtml;
      if (record.livreurId) {
        var liv = DB.get("livreurs", record.livreurId);
        var day = DB.computePrimePeriode(record.livreurId, record.date, record.date);
        primeCardHtml =
          '<div class="card" style="background:var(--color-surface-alt);margin-bottom:18px;">' +
            '<h3 style="margin-top:0;">Prime possible — ' + LM.escapeHtml(liv ? DB.livreurNomComplet(liv) : record.livreurNom) + '</h3>' +
            '<div class="grid grid-3">' +
              miniStat("Bacs livrés (ce livreur)", DB.fmtNum(day.bacs)) +
              miniStat("Palier atteint", day.tierLabel !== "Aucun" ? day.tierLabel.replace(/\s*\(\d+j\)/, "") : "Aucun") +
              miniStat("Prime du jour (barème + ajustements)", DB.fmtEUR(day.total)) +
            '</div>' +
          '</div>';
      } else {
        primeCardHtml = '<p class="text-sm text-faint" style="margin-bottom:18px;">Aucun livreur rattaché à cette entrée : pas de calcul de prime possible.</p>';
      }

      panel.innerHTML =
        '<div style="margin-top:14px;">' +
        '<h3>Activité tous entrepôts confondus — ' + DB.fmtDate(record.date) + '</h3>' +
        '<div class="grid grid-4" style="margin-bottom:18px;">' +
          kpi("truck", "Livraisons", DB.fmtNum(totalLiv)) +
          kpi("box", "Bacs livrés", DB.fmtNum(totalBacs)) +
          kpi("zones", "Kilomètres", DB.fmtNum(Math.round(totalKm))) +
          kpi("alert", "Incidents", DB.fmtNum(totalInc)) +
        '</div>' +
        primeCardHtml +
        '<h3>Détail par entrepôt</h3>' +
        '<div class="table-wrap"><table><thead><tr><th>Entrepôt</th><th class="num">Livreurs actifs</th><th class="num">Livraisons</th><th class="num">Bacs</th><th class="num">Km</th><th class="num">Incidents</th></tr></thead><tbody>' +
          (entList.length ? entList.map(function (e) {
            return '<tr><td>' + LM.escapeHtml(e.label) + '</td><td class="num">' + Object.keys(e.livreurs).length + '</td><td class="num">' + DB.fmtNum(e.liv) + '</td><td class="num">' + DB.fmtNum(e.bacs) + '</td><td class="num">' + DB.fmtNum(e.km) + '</td><td class="num">' + DB.fmtNum(e.incidents) + '</td></tr>';
          }).join("") : '<tr class="empty-row"><td colspan="6">Aucune donnée pour cette journée.</td></tr>') +
        '</tbody></table></div>' +
        '</div>';
    }
  }

  // Exposé pour être réutilisé par d'autres pages (ex : Performance livreurs) sans dépendre
  // du render() propre à cette page. Cette IIFE n'a pas de paramètre "global" (contrairement
  // à db.js/nav.js/etc.) : on attache donc directement sur window.
  window.LMApp = window.LMApp || {};
  window.LMApp.openLivraisonDetail = openLivraisonDetailModal;
})();


/* ==== js/zones.js ==== */
/*! zones.js - Carte des zones géographiques (positionnement des entrepôts + rayons de couverture) */
(function () {
  "use strict";

  // Silhouette schématique de la France (coordonnées 0-100, calquées approximativement
  // sur une projection longitude/latitude — carte stylisée, pas un fond cartographique réel).
  var FRANCE_PATH = "M 56.2 0.6 L 75.4 8.9 L 98 23.3 L 88.5 52.2 L 96.2 77.8 L 94.6 81.1 L 80 85.6 " +
    "L 60.8 92.2 L 42.3 92.2 L 26.9 84.4 L 29.2 71.1 L 30 60 L 29.2 53.3 L 21.5 42.2 L 3.8 28.9 " +
    "L 23.1 26.7 L 26.2 15.6 L 50.8 4.4 Z";

  var KM_PER_UNIT = 10; // échelle approximative de la carte stylisée (100 unités ≈ largeur de la France)

  App.registerPage("zones", { title: "Zones géographiques", subtitle: "Positionnement des entrepôts et rayons de couverture", render: render });

  function render(content) {
    var entrepots = DB.list("entrepots");

    content.innerHTML =
      '<div class="grid" style="grid-template-columns: 1.3fr 1fr; gap:20px; align-items:start;">' +
        '<div class="card">' +
          '<div class="card-header"><div><h2>Carte des zones de couverture</h2><p>Carte de France schématique — glissez-déposez un entrepôt pour ajuster sa position.</p></div></div>' +
          '<div id="mapWrap" style="position:relative;"></div>' +
        '</div>' +
        '<div>' +
          '<div class="card" id="overlapCard"></div>' +
          '<div class="card"><h2>Entrepôts &amp; rayons</h2><p class="text-sm">Ajustez le rayon de couverture (km) et la liste des villes / codes postaux desservis.</p><div id="entList"></div></div>' +
        '</div>' +
      '</div>';

    if (!entrepots.length) {
      document.getElementById("mapWrap").innerHTML = '<div class="empty-state">' + LM.icon("empty") + '<h3>Aucun entrepôt</h3><p>Ajoutez un entrepôt depuis la page Entrepôts pour le voir apparaître ici.</p></div>';
      document.getElementById("overlapCard").innerHTML = "";
      document.getElementById("entList").innerHTML = "";
      return;
    }

    renderMap();
    renderOverlapCard();
    renderEntList();

    function renderMap() {
      var mapWrap = document.getElementById("mapWrap");
      mapWrap.innerHTML = "";
      var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 100 100");
      svg.setAttribute("width", "100%");
      svg.style.background = "#eef2fb";
      svg.style.borderRadius = "12px";
      svg.style.touchAction = "none";
      svg.style.userSelect = "none";
      mapWrap.appendChild(svg);

      var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", FRANCE_PATH);
      path.setAttribute("fill", "#dbe4f7");
      path.setAttribute("stroke", "#a9bce3");
      path.setAttribute("stroke-width", "0.6");
      path.setAttribute("stroke-linejoin", "round");
      svg.appendChild(path);

      var entrepots = DB.list("entrepots");
      entrepots.forEach(function (e, i) {
        var color = LMCharts.seriesColor(i);
        var rUnits = (Number(e.rayonKm) || 0) / KM_PER_UNIT;

        var circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.setAttribute("cx", e.x); circle.setAttribute("cy", e.y);
        circle.setAttribute("r", rUnits);
        circle.setAttribute("fill", color); circle.setAttribute("opacity", "0.14");
        circle.setAttribute("stroke", color); circle.setAttribute("stroke-width", "0.4"); circle.setAttribute("stroke-dasharray", "1.2 0.8");
        svg.appendChild(circle);
      });

      entrepots.forEach(function (e, i) {
        var color = LMCharts.seriesColor(i);
        var g = document.createElementNS("http://www.w3.org/2000/svg", "g");
        g.style.cursor = "grab";

        var marker = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        marker.setAttribute("cx", e.x); marker.setAttribute("cy", e.y);
        marker.setAttribute("r", 2.4);
        marker.setAttribute("fill", color);
        marker.setAttribute("stroke", "#fff"); marker.setAttribute("stroke-width", "0.6");
        g.appendChild(marker);

        var label = document.createElementNS("http://www.w3.org/2000/svg", "text");
        label.setAttribute("x", e.x); label.setAttribute("y", e.y - 3.2);
        label.setAttribute("text-anchor", "middle");
        label.setAttribute("font-size", "3.1");
        label.setAttribute("fill", "#1c2333");
        label.setAttribute("font-weight", "700");
        label.style.paintOrder = "stroke";
        label.style.stroke = "#eef2fb";
        label.style.strokeWidth = "2.4px";
        label.textContent = e.nom.replace(/^Entrepôt\s+/, "");
        g.appendChild(label);

        svg.appendChild(g);

        var dragging = false;
        g.addEventListener("pointerdown", function (evt) {
          dragging = true;
          g.style.cursor = "grabbing";
          g.setPointerCapture(evt.pointerId);
        });
        g.addEventListener("pointermove", function (evt) {
          if (!dragging) return;
          var rect = svg.getBoundingClientRect();
          var x = ((evt.clientX - rect.left) / rect.width) * 100;
          var y = ((evt.clientY - rect.top) / rect.height) * 100;
          x = Math.max(0, Math.min(100, x));
          y = Math.max(0, Math.min(100, y));
          marker.setAttribute("cx", x); marker.setAttribute("cy", y);
          label.setAttribute("x", x); label.setAttribute("y", y - 3.2);
          e._pendingX = x; e._pendingY = y;
        });
        function endDrag(evt) {
          if (!dragging) return;
          dragging = false;
          g.style.cursor = "grab";
          if (e._pendingX !== undefined) {
            DB.update("entrepots", e.id, { x: e._pendingX, y: e._pendingY });
            LM.toast("Position de " + e.nom + " mise à jour.", "success");
            render(content);
          }
        }
        g.addEventListener("pointerup", endDrag);
        g.addEventListener("pointercancel", endDrag);
      });
    }

    function renderOverlapCard() {
      var ents = DB.list("entrepots");
      var overlaps = [];
      for (var i = 0; i < ents.length; i++) {
        for (var j = i + 1; j < ents.length; j++) {
          var a = ents[i], b = ents[j];
          var distUnits = Math.hypot(a.x - b.x, a.y - b.y);
          var distKm = distUnits * KM_PER_UNIT;
          var combined = (Number(a.rayonKm) || 0) + (Number(b.rayonKm) || 0);
          if (combined > 0 && distKm < combined) {
            overlaps.push({ a: a, b: b, distKm: distKm, combined: combined });
          }
        }
      }
      var card = document.getElementById("overlapCard");
      if (!overlaps.length) {
        card.innerHTML = '<h2>Chevauchements de zones</h2><p class="text-sm">Aucun chevauchement détecté entre les rayons de couverture des entrepôts (estimation).</p>';
      } else {
        card.innerHTML = '<h2>Chevauchements de zones</h2><p class="text-sm">Ces entrepôts ont des rayons de couverture qui se recoupent (distance estimée &lt; somme des rayons).</p>' +
          overlaps.map(function (o) {
            return '<div class="flex-between" style="padding:8px 0;border-bottom:1px solid var(--color-border);">' +
              '<span class="text-sm"><strong>' + LM.escapeHtml(o.a.nom) + '</strong> ↔ <strong>' + LM.escapeHtml(o.b.nom) + '</strong></span>' +
              '<span class="badge badge-warning">~' + Math.round(o.distKm) + ' km / ' + o.combined + ' km</span>' +
            '</div>';
          }).join("");
      }
    }

    function renderEntList() {
      var ents = DB.list("entrepots");
      var wrap = document.getElementById("entList");
      wrap.innerHTML = ents.map(function (e, i) {
        var color = LMCharts.seriesColor(i);
        var nbLivreurs = DB.list("livreurs").filter(function (l) { return DB.livreurAEntrepot(l, e.id); }).length;
        var nbVehicules = DB.list("vehicules").filter(function (v) { return v.entrepotId === e.id; }).length;
        return '<div style="border:1px solid var(--color-border);border-radius:10px;padding:14px;margin-bottom:12px;">' +
          '<div class="flex-between" style="margin-bottom:8px;">' +
            '<div class="flex gap-8" style="align-items:center;"><span style="width:10px;height:10px;border-radius:50%;background:' + color + ';display:inline-block;"></span><strong>' + LM.escapeHtml(e.nom) + '</strong></div>' +
            '<span class="text-faint text-sm">' + nbLivreurs + ' livreur(s) · ' + nbVehicules + ' véhicule(s)</span>' +
          '</div>' +
          '<div class="form-row">' +
            '<div class="field mb-0"><label>Rayon de couverture (km)</label><input type="number" min="0" data-rayon="' + e.id + '" value="' + (e.rayonKm || 0) + '" /></div>' +
          '</div>' +
          '<div class="field mb-0" style="margin-top:10px;"><label>Villes / codes postaux couverts</label>' +
            '<textarea data-zones="' + e.id + '" placeholder="ex : Paris 75, Saint-Denis 93200, Aubervilliers 93300…">' + LM.escapeHtml(e.zonesTexte || "") + '</textarea></div>' +
          '<button class="btn btn-secondary btn-sm mt-16" data-save="' + e.id + '">Enregistrer</button>' +
        '</div>';
      }).join("");

      wrap.querySelectorAll("[data-save]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var id = btn.getAttribute("data-save");
          var rayon = Number(wrap.querySelector('[data-rayon="' + id + '"]').value) || 0;
          var zonesTexte = wrap.querySelector('[data-zones="' + id + '"]').value;
          DB.update("entrepots", id, { rayonKm: rayon, zonesTexte: zonesTexte });
          LM.toast("Zone mise à jour.", "success");
          renderMap();
          renderOverlapCard();
        });
      });
    }
  }
})();


/* ==== js/primes.js ==== */
/*! primes.js - Barème de primes par paliers + ajustements manuels par livreur */
(function () {
  "use strict";

  var period = { preset: "mois_courant", start: null, end: null };

  applyPreset("mois_courant");
  App.registerPage("primes", { title: "Primes", subtitle: "Barème par paliers et ajustements manuels", render: render });

  function applyPreset(preset) {
    var end = new Date(); var start = new Date();
    if (preset === "mois_courant") { start = new Date(end.getFullYear(), end.getMonth(), 1); }
    else if (preset === "mois_dernier") { start = new Date(end.getFullYear(), end.getMonth() - 1, 1); end = new Date(end.getFullYear(), end.getMonth(), 0); }
    else if (preset === "30j") { start.setDate(end.getDate() - 29); }
    else if (preset === "90j") { start.setDate(end.getDate() - 89); }
    period.preset = preset;
    period.start = start.toISOString().slice(0, 10);
    period.end = end.toISOString().slice(0, 10);
  }

  function render(content) {
    content.innerHTML =
      '<div class="card">' +
        '<div class="card-header"><div><h2>Période de calcul</h2><p>Les primes sont calculées jour par jour : pour chaque jour travaillé, le nombre de bacs livrés par le livreur ce jour-là détermine le palier atteint, et les montants sont additionnés sur toute la période.</p></div></div>' +
        '<div class="flex gap-8" style="flex-wrap:wrap;margin-bottom:14px;" id="presetRow"></div>' +
        '<div class="form-row" id="customRow" style="' + (period.preset === "custom" ? "" : "display:none;") + '">' +
          '<div class="field"><label>Du</label><input type="date" id="customStart" value="' + period.start + '" /></div>' +
          '<div class="field"><label>Au</label><input type="date" id="customEnd" value="' + period.end + '" /></div>' +
          '<div class="field" style="align-self:flex-end;"><button class="btn btn-secondary" id="applyCustom">Appliquer</button></div>' +
        '</div>' +
      '</div>' +
      '<div class="grid grid-4" id="kpiRow" style="margin-bottom:22px;"></div>' +
      '<div class="card">' +
        '<div class="card-header"><div><h2>Barème par paliers</h2><p>Chaque jour travaillé, le palier le plus élevé atteint ce jour-là détermine le montant ajouté ce jour-là (paliers non cumulables entre eux sur une même journée).</p></div>' +
        '<button class="btn btn-primary" id="btnAddTier">' + LM.icon("plus") + ' Ajouter un palier</button></div>' +
        '<div class="table-wrap"><table><thead><tr><th>Libellé</th><th class="num">Seuil (bacs / jour)</th><th class="num">Montant</th><th></th></tr></thead><tbody id="tiersBody"></tbody></table></div>' +
      '</div>' +
      '<div class="card">' +
        '<div class="card-header"><div><h2>Primes par livreur</h2><p>Calcul automatique (somme des paliers atteints jour par jour) + ajustement manuel possible (bonus ou malus).</p></div></div>' +
        '<div class="table-wrap"><table><thead><tr>' +
          '<th>Livreur</th><th>Entrepôt</th><th class="num">Jours travaillés</th><th class="num">Bacs livrés</th><th class="num">Moyenne bacs/jour</th><th>Paliers atteints</th><th class="num">Prime barème</th><th class="num">Ajustement</th><th class="num">Total</th><th></th>' +
        '</tr></thead><tbody id="primesBody"></tbody></table></div>' +
      '</div>';

    renderPresetRow();
    renderTiers();
    renderPrimesTable();

    function renderPresetRow() {
      var presets = [
        { key: "mois_courant", label: "Mois en cours" },
        { key: "mois_dernier", label: "Mois dernier" },
        { key: "30j", label: "30 derniers jours" },
        { key: "90j", label: "90 derniers jours" },
        { key: "custom", label: "Période personnalisée" }
      ];
      var row = document.getElementById("presetRow");
      row.innerHTML = presets.map(function (p) {
        return '<button class="btn btn-sm ' + (period.preset === p.key ? "btn-primary" : "btn-secondary") + '" data-preset="' + p.key + '">' + p.label + '</button>';
      }).join("");
      row.querySelectorAll("[data-preset]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var key = btn.getAttribute("data-preset");
          if (key === "custom") { period.preset = "custom"; document.getElementById("customRow").style.display = ""; renderPresetRow(); return; }
          applyPreset(key);
          renderPresetRow();
          renderKpis();
          renderPrimesTable();
        });
      });
      var applyCustomBtn = document.getElementById("applyCustom");
      if (applyCustomBtn) {
        applyCustomBtn.addEventListener("click", function () {
          var s = document.getElementById("customStart").value, e = document.getElementById("customEnd").value;
          if (!s || !e || s > e) { LM.toast("Plage de dates invalide.", "danger"); return; }
          period.preset = "custom"; period.start = s; period.end = e;
          renderKpis(); renderPrimesTable();
        });
      }
      renderKpis();
    }

    // La prime n'est pas calculée sur une moyenne quotidienne sur l'ensemble de la période :
    // chaque jour travaillé est évalué indépendamment. Pour un livreur donné, on additionne
    // d'abord tous les bacs livrés CE JOUR-LÀ (il peut y avoir plusieurs lignes le même jour,
    // ex : plusieurs entrepôts), on détermine le palier le plus élevé atteint par ce total
    // journalier, puis on ajoute le montant de ce palier à la prime. La prime de la période est
    // la somme de ces montants journaliers sur tous les jours travaillés.
    function computeAll() {
      var tiers = DB.list("primesTiers").slice().sort(function (a, b) { return a.seuilBacsJour - b.seuilBacsJour; });
      var livraisons = DB.list("livraisons").filter(function (r) { return r.date >= period.start && r.date <= period.end; });
      var byLivreur = {};
      livraisons.forEach(function (r) {
        var key = r.livreurId || (r.livreurNom ? "n:" + DB.normalizeStr(r.livreurNom) : null);
        if (!key) return;
        if (!byLivreur[key]) byLivreur[key] = { livreurId: r.livreurId || null, nom: r.livreurNom || DB.livreurNom(r.livreurId) || "Inconnu", entrepotId: r.entrepotId, jours: {} };
        // Bacs livrés ce jour-là, cumulés si plusieurs lignes tombent sur la même date.
        byLivreur[key].jours[r.date] = (byLivreur[key].jours[r.date] || 0) + (Number(r.nbBacs) || 0);
      });
      // s'assure que tous les livreurs actifs apparaissent même à 0 bac
      DB.list("livreurs").forEach(function (l) {
        if (!byLivreur[l.id]) byLivreur[l.id] = { livreurId: l.id, nom: DB.livreurNomComplet(l), entrepotId: (l.entrepotIds || [])[0] || null, jours: {} };
      });

      var ajustementsAll = DB.list("primesAjustements");

      return Object.keys(byLivreur).map(function (key) {
        var row = byLivreur[key];
        var dates = Object.keys(row.jours);
        var nbJours = dates.length;
        var totalBacs = dates.reduce(function (a, d) { return a + row.jours[d]; }, 0);
        var moyenneJour = nbJours ? totalBacs / nbJours : 0;

        // Palier atteint (et montant ajouté) pour chaque jour travaillé, puis somme sur la période.
        var baremeMontant = 0;
        var tierCounts = {}; // libellé de palier -> nombre de jours où ce palier a été atteint
        dates.forEach(function (d) {
          var bacsJour = row.jours[d];
          var tierReached = null;
          tiers.forEach(function (t) { if (bacsJour >= t.seuilBacsJour) tierReached = t; });
          if (tierReached) {
            baremeMontant += tierReached.montant;
            tierCounts[tierReached.label] = (tierCounts[tierReached.label] || 0) + 1;
          }
        });
        var tierLabel = tiers.filter(function (t) { return tierCounts[t.label]; })
          .map(function (t) { return t.label + " (" + tierCounts[t.label] + "j)"; })
          .join(", ") || "Aucun";

        // Ajustements manuels : on additionne TOUS ceux dont la période est entièrement contenue
        // dans la période affichée (cela inclut les primes ponctuelles ajoutées pour une journée
        // précise depuis le journal, en plus de l'éventuel ajustement propre à cette période exacte
        // saisi via le bouton "Ajuster" ci-dessous). On retient à part l'ajustement correspondant
        // EXACTEMENT à la période affichée : c'est celui-là (et lui seul) que le bouton "Ajuster"
        // permet de créer/modifier, pour ne pas mélanger les deux mécanismes.
        var containedAdjs = row.livreurId ? ajustementsAll.filter(function (a) {
          return a.livreurId === row.livreurId && a.periodeDebut >= period.start && a.periodeFin <= period.end;
        }) : [];
        var ajustementMontant = containedAdjs.reduce(function (s, a) { return s + (Number(a.montant) || 0); }, 0);
        var exactAdj = row.livreurId ? ajustementsAll.find(function (a) {
          return a.livreurId === row.livreurId && a.periodeDebut === period.start && a.periodeFin === period.end;
        }) : null;
        return {
          key: key, livreurId: row.livreurId, nom: row.nom, entrepotId: row.entrepotId,
          bacs: totalBacs, nbJours: nbJours, moyenneJour: moyenneJour,
          tierLabel: tierLabel, tierCounts: tierCounts,
          bareme: baremeMontant, ajustement: ajustementMontant,
          exactAdjustment: exactAdj ? Number(exactAdj.montant) || 0 : 0, exactMotif: exactAdj ? exactAdj.motif : "",
          total: baremeMontant + ajustementMontant
        };
      }).sort(function (a, b) { return b.total - a.total; });
    }

    function renderKpis() {
      var rows = computeAll();
      var totalPrimes = rows.reduce(function (a, r) { return a + r.total; }, 0);
      var nbPrimes = rows.filter(function (r) { return r.total > 0; }).length;
      var moyenne = nbPrimes ? totalPrimes / nbPrimes : 0;
      var nbPalierMax = 0;
      var tiers = DB.list("primesTiers");
      if (tiers.length) {
        var maxTier = tiers.reduce(function (a, b) { return a.seuilBacsJour > b.seuilBacsJour ? a : b; });
        // Compte les livreurs ayant atteint le palier le plus haut au moins un jour sur la période.
        nbPalierMax = rows.filter(function (r) { return r.tierCounts && r.tierCounts[maxTier.label]; }).length;
      }
      document.getElementById("kpiRow").innerHTML =
        kpi("euro", "Total des primes", DB.fmtEUR(totalPrimes)) +
        kpi("livreur", "Livreurs primés", DB.fmtNum(nbPrimes)) +
        kpi("euro", "Prime moyenne", DB.fmtEUR(moyenne)) +
        kpi("primes", "Livreurs ayant atteint le palier max (≥1j)", DB.fmtNum(nbPalierMax));
    }

    function renderTiers() {
      var tiers = DB.list("primesTiers").slice().sort(function (a, b) { return a.seuilBacsJour - b.seuilBacsJour; });
      var tbody = document.getElementById("tiersBody");
      document.getElementById("btnAddTier").onclick = function () { openTierForm(null); };
      if (!tiers.length) { tbody.innerHTML = '<tr class="empty-row"><td colspan="4">Aucun palier configuré. Toutes les primes automatiques seront nulles.</td></tr>'; return; }
      tbody.innerHTML = tiers.map(function (t) {
        return '<tr><td>' + LM.escapeHtml(t.label || "—") + '</td><td class="num">≥ ' + DB.fmtNum(t.seuilBacsJour) + ' bacs/jour</td><td class="num">' + DB.fmtEUR(t.montant) + '</td>' +
          '<td class="actions"><button class="btn btn-ghost btn-sm btn-icon" data-edit="' + t.id + '">' + LM.icon("edit") + '</button>' +
          '<button class="btn btn-ghost btn-sm btn-icon" data-del="' + t.id + '">' + LM.icon("trash") + '</button></td></tr>';
      }).join("");
      tbody.querySelectorAll("[data-edit]").forEach(function (btn) { btn.addEventListener("click", function () { openTierForm(DB.get("primesTiers", btn.getAttribute("data-edit"))); }); });
      tbody.querySelectorAll("[data-del]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var id = btn.getAttribute("data-del");
          LM.confirmDialog("Supprimer ce palier ?", function () {
            DB.remove("primesTiers", id);
            LM.toast("Palier supprimé.", "success");
            renderTiers(); renderKpis(); renderPrimesTable();
          });
        });
      });
    }

    function openTierForm(existing) {
      var isEdit = !!existing;
      var t = existing || { label: "", seuilBacsJour: "", montant: "" };
      LM.openModal({
        title: isEdit ? "Modifier le palier" : "Ajouter un palier",
        bodyHtml:
          '<form id="tierForm">' +
            field("Libellé", "label", t.label, "text", false, "ex : Palier 1") +
            field("Seuil (nombre de bacs livrés en une journée) *", "seuilBacsJour", t.seuilBacsJour, "number", true, "Ce seuil est comparé indépendamment au total de bacs livrés par le livreur CHAQUE jour travaillé (et non à une moyenne sur la période) : le palier le plus élevé atteint ce jour-là détermine le montant ajouté pour ce jour.") +
            field("Montant de la prime (€) *", "montant", t.montant, "number", true) +
          '</form>',
        footerHtml: '<button class="btn btn-secondary" id="cancelBtn">Annuler</button><button class="btn btn-primary" id="saveBtn">' + (isEdit ? "Enregistrer" : "Ajouter") + '</button>',
        onMount: function (modal) {
          modal.querySelector("#cancelBtn").addEventListener("click", LM.closeModal);
          modal.querySelector("#saveBtn").addEventListener("click", function () {
            var fd = new FormData(modal.querySelector("#tierForm"));
            var seuil = Number(fd.get("seuilBacsJour")), montant = Number(fd.get("montant"));
            if (isNaN(seuil) || isNaN(montant)) { LM.toast("Seuil et montant sont obligatoires.", "danger"); return; }
            var payload = { label: (fd.get("label") || "").toString().trim() || ("Palier " + DB.fmtNum(seuil)), seuilBacsJour: seuil, montant: montant };
            if (isEdit) DB.update("primesTiers", t.id, payload); else DB.add("primesTiers", payload);
            LM.toast("Barème mis à jour.", "success");
            LM.closeModal();
            renderTiers(); renderKpis(); renderPrimesTable();
          });
        }
      });
    }

    function renderPrimesTable() {
      var rows = computeAll();
      var tbody = document.getElementById("primesBody");
      if (!rows.length) { tbody.innerHTML = '<tr class="empty-row"><td colspan="10">Aucune donnée sur cette période.</td></tr>'; return; }
      tbody.innerHTML = rows.map(function (r) {
        var ent = r.entrepotId ? DB.get("entrepots", r.entrepotId) : null;
        return '<tr>' +
          '<td><strong>' + LM.escapeHtml(r.nom) + '</strong></td>' +
          '<td>' + (ent ? LM.escapeHtml(ent.nom) : '<span class="text-faint">—</span>') + '</td>' +
          '<td class="num">' + DB.fmtNum(r.nbJours) + '</td>' +
          '<td class="num">' + DB.fmtNum(r.bacs) + '</td>' +
          '<td class="num">' + r.moyenneJour.toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + '</td>' +
          '<td class="text-sm">' + LM.escapeHtml(r.tierLabel) + '</td>' +
          '<td class="num">' + DB.fmtEUR(r.bareme) + '</td>' +
          '<td class="num">' + (r.ajustement ? (r.ajustement > 0 ? "+" : "") + DB.fmtEUR(r.ajustement) : "—") + '</td>' +
          '<td class="num"><strong>' + DB.fmtEUR(r.total) + '</strong></td>' +
          '<td class="actions">' + (r.livreurId ? '<button class="btn btn-ghost btn-sm" data-adjust="' + r.key + '">Ajuster</button>' : '') + '</td>' +
        '</tr>';
      }).join("");

      tbody.querySelectorAll("[data-adjust]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var key = btn.getAttribute("data-adjust");
          var row = rows.find(function (r) { return r.key === key; });
          openAdjustForm(row);
        });
      });
    }

    function openAdjustForm(row) {
      var otherAdj = row.ajustement - row.exactAdjustment;
      LM.openModal({
        title: "Ajustement manuel — " + row.nom,
        bodyHtml:
          '<form id="adjForm">' +
            '<p class="text-sm">Période : ' + DB.fmtDate(period.start) + ' → ' + DB.fmtDate(period.end) + '. Prime barème actuelle : ' + DB.fmtEUR(row.bareme) + '.</p>' +
            (otherAdj ? '<p class="text-sm text-faint">Le total inclut déjà ' + (otherAdj > 0 ? "+" : "") + DB.fmtEUR(otherAdj) + ' de prime(s) ponctuelle(s) ajoutée(s) depuis le journal (voir l\'historique du livreur) — non modifiables ici.</p>' : "") +
            field("Ajustement pour cette période précise (€) — positif pour un bonus, négatif pour un malus", "montant", row.exactAdjustment || 0, "number") +
            '<div class="field"><label>Motif</label><textarea name="motif">' + LM.escapeHtml(row.exactMotif || "") + '</textarea></div>' +
          '</form>',
        footerHtml: '<button class="btn btn-secondary" id="cancelBtn">Annuler</button><button class="btn btn-primary" id="saveBtn">Enregistrer</button>',
        onMount: function (modal) {
          modal.querySelector("#cancelBtn").addEventListener("click", LM.closeModal);
          modal.querySelector("#saveBtn").addEventListener("click", function () {
            var fd = new FormData(modal.querySelector("#adjForm"));
            var montant = Number(fd.get("montant")) || 0;
            var motif = (fd.get("motif") || "").toString().trim();
            var existing = DB.list("primesAjustements").find(function (a) { return a.livreurId === row.livreurId && a.periodeDebut === period.start && a.periodeFin === period.end; });
            if (existing) {
              DB.update("primesAjustements", existing.id, { montant: montant, motif: motif });
            } else if (montant !== 0 || motif) {
              DB.add("primesAjustements", { livreurId: row.livreurId, periodeDebut: period.start, periodeFin: period.end, montant: montant, motif: motif });
            }
            DB.logHistorique("Primes", existing ? "modification" : "ajout", (existing ? "Modification" : "Ajout") + " ajustement de prime : " + row.nom + " (" + DB.fmtDate(period.start) + " → " + DB.fmtDate(period.end) + ") : " + (montant > 0 ? "+" : "") + DB.fmtEUR(montant));
            LM.toast("Ajustement enregistré.", "success");
            LM.closeModal();
            renderKpis(); renderPrimesTable();
          });
        }
      });
    }
  }

  function field(label, name, value, type, required, hint) {
    type = type || "text";
    return '<div class="field"><label>' + label + '</label>' +
      '<input type="' + type + '" name="' + name + '" value="' + LM.escapeHtml(value !== undefined && value !== null ? value : "") + '"' + (required ? " required" : "") + ' />' +
      (hint ? '<div class="hint">' + hint + '</div>' : '') +
      '</div>';
  }

  function kpi(iconName, label, value) {
    return '<div class="kpi"><div class="kpi-label"><span class="kpi-icon">' + LM.icon(iconName) + '</span>' + label + '</div><div class="kpi-value">' + value + '</div></div>';
  }
})();


/* ==== js/performance.js ==== */
/*! performance.js - Fiche de performance individuelle par livreur : profil, KPIs, graphiques,
 * primes, véhicule/réparations et journal des livraisons, sur une période choisie. */
(function () {
  "use strict";

  var STATUTS_LIV = {
    actif: { label: "Actif", cls: "badge-success" },
    conge: { label: "En congé", cls: "badge-info" },
    arret: { label: "Arrêt / absent", cls: "badge-warning" },
    inactif: { label: "Inactif", cls: "badge-muted" }
  };
  var VEH_STATUTS_LOCAL = {
    service: { label: "En service", cls: "badge-success" },
    maintenance: { label: "En maintenance", cls: "badge-warning" },
    hors_service: { label: "Hors service", cls: "badge-danger" }
  };
  var PRIORITE_CLS = { basse: "badge-muted", normale: "badge-info", haute: "badge-warning", urgente: "badge-danger" };
  var STATUT_TICKET_LABELS = { nouveau: "À réparer", en_cours: "En réparation", termine: "Réparé", annule: "Annulé" };

  var period = { preset: "30j", start: null, end: null };
  var selectedLivreurId = null;
  var journalPage = 1;
  var JOURNAL_PAGE_SIZE = 15;

  applyPreset("30j");
  App.registerPage("performance", { title: "Performance livreurs", subtitle: "Fiche détaillée d'activité, de primes et de matériel par livreur", render: render });

  function applyPreset(preset) {
    var end = new Date();
    var start = new Date();
    if (preset === "7j") { start.setDate(end.getDate() - 6); }
    else if (preset === "30j") { start.setDate(end.getDate() - 29); }
    else if (preset === "90j") { start.setDate(end.getDate() - 89); }
    else if (preset === "mois_courant") { start = new Date(end.getFullYear(), end.getMonth(), 1); }
    else if (preset === "mois_dernier") {
      start = new Date(end.getFullYear(), end.getMonth() - 1, 1);
      end = new Date(end.getFullYear(), end.getMonth(), 0);
    }
    period.preset = preset;
    period.start = start.toISOString().slice(0, 10);
    period.end = end.toISOString().slice(0, 10);
  }

  function periodLengthDays() {
    var d1 = new Date(period.start), d2 = new Date(period.end);
    return Math.round((d2 - d1) / 86400000) + 1;
  }

  function previousPeriodRange() {
    var days = periodLengthDays();
    var start = new Date(period.start);
    var prevEnd = new Date(start); prevEnd.setDate(prevEnd.getDate() - 1);
    var prevStart = new Date(prevEnd); prevStart.setDate(prevStart.getDate() - days + 1);
    return { start: prevStart.toISOString().slice(0, 10), end: prevEnd.toISOString().slice(0, 10) };
  }

  function sumField(rows, field) { return rows.reduce(function (a, r) { return a + (Number(r[field]) || 0); }, 0); }

  // Nombre de livraisons en retard sur un ensemble d'entrées du journal, à partir des
  // signalements de la page Retards (DB.retardPourLivraison), et non plus du champ générique
  // "incidents" saisi à l'import/en manuel.
  function sumRetard(rows) {
    return rows.reduce(function (a, r) {
      var ret = DB.retardPourLivraison(r.id);
      return a + (ret ? (Number(ret.nbLivraisonsRetard) || 0) : 0);
    }, 0);
  }

  function trendHtml(current, previous) {
    if (!previous) return '<div class="kpi-trend flat">Pas de période de référence</div>';
    var diff = current - previous;
    var pct = previous !== 0 ? Math.round((diff / previous) * 100) : (current > 0 ? 100 : 0);
    var cls = diff > 0 ? "up" : diff < 0 ? "down" : "flat";
    var arrow = diff > 0 ? "▲" : diff < 0 ? "▼" : "→";
    return '<div class="kpi-trend ' + cls + '">' + arrow + ' ' + (pct >= 0 ? "+" : "") + pct + '% vs période précédente</div>';
  }

  // Classe l'ensemble des livreurs par nombre de bacs livrés sur la période (tous à 0 par défaut,
  // y compris ceux sans aucune livraison ce jour-là, pour que le rang reflète toute l'équipe).
  function computeTeamRanking(start, end) {
    var byLiv = {};
    DB.list("livreurs").forEach(function (l) { byLiv[l.id] = 0; });
    DB.list("livraisons").filter(function (r) { return r.date >= start && r.date <= end && r.livreurId; }).forEach(function (r) {
      if (byLiv[r.livreurId] !== undefined) byLiv[r.livreurId] += Number(r.nbBacs) || 0;
    });
    return Object.keys(byLiv).map(function (id) { return { id: id, bacs: byLiv[id] }; }).sort(function (a, b) { return b.bacs - a.bacs; });
  }

  function render(content) {
    var livreurs = DB.list("livreurs").slice().sort(function (a, b) { return DB.livreurNomComplet(a).localeCompare(DB.livreurNomComplet(b), "fr"); });
    if (!selectedLivreurId || !livreurs.some(function (l) { return l.id === selectedLivreurId; })) {
      selectedLivreurId = livreurs.length ? livreurs[0].id : null;
    }

    content.innerHTML =
      '<div class="card">' +
        '<div class="card-header"><div><h2>Sélection</h2><p>Choisissez un livreur et une période pour afficher sa fiche de performance.</p></div>' +
          (livreurs.length ? '<button class="btn btn-pdf" id="btnExportPerfPdf">' + LM.icon("file") + ' Exporter en PDF</button>' : '') +
        '</div>' +
        (livreurs.length ?
          '<div class="form-row" style="margin-bottom:6px;">' +
            '<div class="field" style="max-width:360px;"><label>Livreur</label><select id="selLivreur">' +
              livreurs.map(function (l) { return '<option value="' + l.id + '"' + (l.id === selectedLivreurId ? " selected" : "") + '>' + LM.escapeHtml(DB.livreurNomComplet(l)) + '</option>'; }).join("") +
            '</select></div>' +
          '</div>' +
          '<div class="flex gap-8" style="flex-wrap:wrap;margin-bottom:14px;" id="presetRow"></div>' +
          '<div class="form-row" id="customRow" style="' + (period.preset === "custom" ? "" : "display:none;") + '">' +
            '<div class="field"><label>Du</label><input type="date" id="customStart" value="' + period.start + '" /></div>' +
            '<div class="field"><label>Au</label><input type="date" id="customEnd" value="' + period.end + '" /></div>' +
            '<div class="field" style="align-self:flex-end;"><button class="btn btn-secondary" id="applyCustom">Appliquer</button></div>' +
          '</div>' :
          '<p class="text-sm">Aucun livreur enregistré pour le moment. Ajoutez-en depuis la page <strong>Livreurs</strong>.</p>'
        ) +
      '</div>' +
      '<div id="perfBody"></div>';

    if (!livreurs.length) return;

    document.getElementById("btnExportPerfPdf").addEventListener("click", function () { openExportPerfPdfModal(livreurs); });

    document.getElementById("selLivreur").addEventListener("change", function (e) {
      selectedLivreurId = e.target.value;
      journalPage = 1;
      renderBody();
    });

    renderPresetRow();
    renderBody();

    function renderPresetRow() {
      var presets = [
        { key: "7j", label: "7 derniers jours" },
        { key: "30j", label: "30 derniers jours" },
        { key: "90j", label: "90 derniers jours" },
        { key: "mois_courant", label: "Mois en cours" },
        { key: "mois_dernier", label: "Mois dernier" },
        { key: "custom", label: "Période personnalisée" }
      ];
      var row = document.getElementById("presetRow");
      row.innerHTML = presets.map(function (p) {
        return '<button class="btn btn-sm ' + (period.preset === p.key ? "btn-primary" : "btn-secondary") + '" data-preset="' + p.key + '">' + p.label + '</button>';
      }).join("");
      row.querySelectorAll("[data-preset]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var key = btn.getAttribute("data-preset");
          if (key === "custom") { period.preset = "custom"; document.getElementById("customRow").style.display = ""; renderPresetRow(); return; }
          applyPreset(key);
          renderPresetRow();
          journalPage = 1;
          renderBody();
        });
      });
      var applyCustomBtn = document.getElementById("applyCustom");
      if (applyCustomBtn) {
        applyCustomBtn.addEventListener("click", function () {
          var s = document.getElementById("customStart").value, e = document.getElementById("customEnd").value;
          if (!s || !e || s > e) { LM.toast("Plage de dates invalide.", "danger"); return; }
          period.preset = "custom"; period.start = s; period.end = e;
          journalPage = 1;
          renderBody();
        });
      }
    }

    // ------------------------------------------------------------------
    // Corps de la fiche (tout ce qui dépend du livreur/période sélectionnés)
    // ------------------------------------------------------------------
    function renderBody() {
      var panel = document.getElementById("perfBody");
      var liv = DB.get("livreurs", selectedLivreurId);
      if (!liv) { panel.innerHTML = ""; return; }

      var rows = DB.list("livraisons").filter(function (r) { return r.livreurId === selectedLivreurId && r.date >= period.start && r.date <= period.end; });
      var prevRange = previousPeriodRange();
      var prevRows = DB.list("livraisons").filter(function (r) { return r.livreurId === selectedLivreurId && r.date >= prevRange.start && r.date <= prevRange.end; });

      panel.innerHTML =
        profileCardHtml(liv) +
        kpiRowsHtml(rows, prevRows) +
        chartsHtml() +
        primeCardHtml(liv) +
        vehiculeCardHtml(liv) +
        journalCardHtml();

      mountCharts(rows);
      mountJournal(rows);
    }

    // ---------------- Profil ----------------
    function profileCardHtml(liv) {
      var statut = STATUTS_LIV[liv.statut] || STATUTS_LIV.inactif;
      var initials = ((liv.prenom || "?")[0] + (liv.nom || "?")[0]).toUpperCase();
      var ents = (liv.entrepotIds || []).map(function (id) { return DB.get("entrepots", id); }).filter(Boolean);
      var veh = liv.vehiculeId ? DB.get("vehicules", liv.vehiculeId) : null;
      return '<div class="card">' +
        '<div class="flex gap-16" style="align-items:flex-start;flex-wrap:wrap;margin-top:14px;">' +
          '<span class="avatar" style="width:56px;height:56px;font-size:1.3rem;flex-shrink:0;">' + initials + '</span>' +
          '<div style="flex:1;min-width:240px;">' +
            '<div class="flex gap-10" style="align-items:center;flex-wrap:wrap;"><h2 style="margin:0;">' + LM.escapeHtml(DB.livreurNomComplet(liv)) + '</h2><span class="badge ' + statut.cls + '">' + statut.label + '</span></div>' +
            '<p class="text-sm text-faint" style="margin:4px 0 12px;">' + LM.escapeHtml(liv.zone || "Zone non renseignée") + (liv.dateEmbauche ? ' — embauché(e) le ' + DB.fmtDate(liv.dateEmbauche) : '') + '</p>' +
            '<div class="flex gap-18" style="flex-wrap:wrap;">' +
              infoChip("Téléphone", liv.telephone) +
              infoChip("Email", liv.email) +
              infoChip("Permis", liv.permis) +
              infoChip("Entrepôts", ents.length ? ents.map(function (e) { return e.nom; }).join(", ") : "Non rattaché") +
              infoChip("Véhicule", veh ? (veh.plaque + " (" + veh.type + ")") : "Aucun") +
            '</div>' +
            (Array.isArray(liv.tags) && liv.tags.length ? '<p class="text-faint text-sm icon-inline" style="margin-top:10px;">' + LM.icon("tag") + ' ' + liv.tags.map(function (t) { return LM.escapeHtml(t); }).join(", ") + '</p>' : '') +
          '</div>' +
        '</div>' +
      '</div>';
    }

    function infoChip(label, value) {
      return '<div><div class="text-faint" style="font-size:0.72rem;text-transform:uppercase;letter-spacing:.03em;">' + label + '</div><div class="text-sm">' + (value ? LM.escapeHtml(value) : "—") + '</div></div>';
    }

    // ---------------- KPIs ----------------
    function kpiRowsHtml(rows, prevRows) {
      var nbLivraisons = sumField(rows, "nbLivraisons"), nbBacs = sumField(rows, "nbBacs"), km = sumField(rows, "km"), retard = sumRetard(rows);
      var prevLivraisons = sumField(prevRows, "nbLivraisons"), prevBacs = sumField(prevRows, "nbBacs"), prevKm = sumField(prevRows, "km"), prevRetard = sumRetard(prevRows);

      var joursSet = {};
      rows.forEach(function (r) { joursSet[r.date] = true; });
      var nbJours = Object.keys(joursSet).length;
      var moyenneBacsJour = nbJours ? nbBacs / nbJours : 0;
      var ranking = computeTeamRanking(period.start, period.end);
      var rankIdx = ranking.findIndex(function (r) { return r.id === selectedLivreurId; });
      var rankLabel = rankIdx >= 0 ? ("#" + (rankIdx + 1) + " / " + ranking.length) : "—";
      var tauxRetard = nbLivraisons ? (retard / nbLivraisons * 100) : 0;

      return '<div class="grid grid-4" style="margin:22px 0;">' +
          kpi("truck", "Livraisons", DB.fmtNum(nbLivraisons), trendHtml(nbLivraisons, prevLivraisons)) +
          kpi("box", "Bacs livrés", DB.fmtNum(nbBacs), trendHtml(nbBacs, prevBacs)) +
          kpi("zones", "Kilomètres parcourus", DB.fmtNum(Math.round(km)), trendHtml(km, prevKm)) +
          kpi("retard", "Livraisons en retard", DB.fmtNum(retard), trendHtml(retard, prevRetard)) +
        '</div>' +
        '<div class="grid grid-4" style="margin-bottom:22px;">' +
          kpi("clock", "Jours travaillés", DB.fmtNum(nbJours)) +
          kpi("box", "Moyenne bacs / jour", moyenneBacsJour.toLocaleString("fr-FR", { maximumFractionDigits: 1 })) +
          kpi("trend", "Rang équipe (bacs livrés)", rankLabel) +
          kpi("retard", "Taux de retard", nbLivraisons ? tauxRetard.toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " %" : "—") +
        '</div>';
    }

    // ---------------- Graphiques ----------------
    function chartsHtml() {
      return '<div class="grid grid-2">' +
        '<div class="card"><h3>Bacs livrés par jour</h3><p class="text-sm">Sur la période sélectionnée.</p><div id="perfChartLine" style="margin-top:10px;"></div></div>' +
        '<div class="card"><h3>Répartition des livraisons par entrepôt</h3><p class="text-sm">Part de chaque site pour ce livreur sur la période.</p><div id="perfChartDonut" style="margin-top:10px;"></div></div>' +
      '</div>' +
      '<div class="grid grid-2">' +
        '<div class="card"><h3>Retards : motifs les plus fréquents</h3><p class="text-sm">D\'après les signalements de la page <strong>Retards</strong> liés à ce livreur (liste personnalisable depuis Annexes).</p><div id="perfChartMotifs" style="margin-top:10px;"></div></div>' +
        '<div class="card"><h3>Clients livrés en retard</h3><p class="text-sm">Nombre de signalements par client, sur la période sélectionnée.</p><div id="perfChartClients" style="margin-top:10px;"></div></div>' +
      '</div>';
    }

    function mountCharts(rows) {
      var byDay = {};
      rows.forEach(function (r) { byDay[r.date] = (byDay[r.date] || 0) + (Number(r.nbBacs) || 0); });
      var days = [];
      var d0 = new Date(period.start), d1 = new Date(period.end);
      for (var d = new Date(d0); d <= d1; d.setDate(d.getDate() + 1)) days.push(d.toISOString().slice(0, 10));
      var labels = days.map(function (iso) { return iso.slice(8, 10) + "/" + iso.slice(5, 7); });
      var data = days.map(function (iso) { return byDay[iso] || 0; });
      LMCharts.lineChart(document.getElementById("perfChartLine"), { labels: labels, series: [{ name: "Bacs", data: data }], height: 240 });

      var byEnt = {};
      rows.forEach(function (r) {
        var k = r.entrepotId || ("n:" + DB.normalizeStr(r.entrepotNom || ""));
        var label = r.entrepotId ? (DB.entrepotNom(r.entrepotId) || r.entrepotNom || "Entrepôt inconnu") : (r.entrepotNom || "Non renseigné");
        if (!byEnt[k]) byEnt[k] = { label: label, val: 0 };
        byEnt[k].val += Number(r.nbLivraisons) || 0;
      });
      var entList = Object.keys(byEnt).map(function (k) { return byEnt[k]; }).sort(function (a, b) { return b.val - a.val; });
      LMCharts.donutChart(document.getElementById("perfChartDonut"), { data: entList.map(function (e) { return { label: e.label, value: e.val }; }), height: 220 });

      // Retards de ce livreur sur la période : motifs (justificatifs) et clients concernés,
      // repris des signalements de la page Retards (DB.retardPourLivraison / r.clients).
      var byMotif = {}, byClient = {};
      rows.forEach(function (r) {
        var ret = DB.retardPourLivraison(r.id);
        if (!ret) return;
        (ret.clients || []).forEach(function (c) {
          (c.justifications || []).forEach(function (key) {
            if (!byMotif[key]) byMotif[key] = { label: DB.listeLabel("motifsRetard", key) || "Justificatif supprimé", n: 0 };
            byMotif[key].n++;
          });
          var clientLabel = DB.clientNom(c.clientId) || "Client supprimé";
          if (!byClient[c.clientId]) byClient[c.clientId] = { label: clientLabel, n: 0 };
          byClient[c.clientId].n++;
        });
      });
      var motifList = Object.keys(byMotif).map(function (k) { return byMotif[k]; }).sort(function (a, b) { return b.n - a.n; });
      LMCharts.barChart(document.getElementById("perfChartMotifs"), {
        labels: motifList.map(function (m) { return m.label; }),
        series: [{ name: "Sélections", data: motifList.map(function (m) { return m.n; }) }],
        height: 240
      });
      var clientList = Object.keys(byClient).map(function (k) { return byClient[k]; }).sort(function (a, b) { return b.n - a.n; }).slice(0, 8);
      LMCharts.barChart(document.getElementById("perfChartClients"), {
        labels: clientList.map(function (c) { return c.label; }),
        series: [{ name: "Signalements", data: clientList.map(function (c) { return c.n; }) }],
        height: 240
      });
    }

    // ---------------- Primes ----------------
    function primeCardHtml(liv) {
      var calc = DB.computePrimePeriode(liv.id, period.start, period.end);
      var allAdj = DB.list("primesAjustements").filter(function (a) { return a.livreurId === liv.id; })
        .slice().sort(function (a, b) { return (b.periodeDebut || "").localeCompare(a.periodeDebut || ""); });
      var historyRows = allAdj.slice(0, 8);

      return '<div class="card">' +
        '<div class="card-header"><div><h2>Primes</h2><p>Calcul jour par jour sur la période sélectionnée (' + DB.fmtDate(period.start) + ' → ' + DB.fmtDate(period.end) + ').</p></div></div>' +
        '<div class="grid grid-4" style="margin-bottom:18px;">' +
          miniStat("Jours travaillés", DB.fmtNum(calc.nbJours)) +
          miniStat("Paliers atteints", LM.escapeHtml(calc.tierLabel)) +
          miniStat("Prime barème", DB.fmtEUR(calc.bareme)) +
          miniStat("Total (barème + ajustements)", DB.fmtEUR(calc.total)) +
        '</div>' +
        (historyRows.length ?
          '<h3>Historique des ajustements manuels (' + allAdj.length + ')</h3>' +
          '<div class="table-wrap"><table><thead><tr><th>Période</th><th class="num">Montant</th><th>Motif</th></tr></thead><tbody>' +
            historyRows.map(function (a) {
              var periodeStr = a.periodeDebut === a.periodeFin ? DB.fmtDate(a.periodeDebut) : (DB.fmtDate(a.periodeDebut) + " → " + DB.fmtDate(a.periodeFin));
              return '<tr><td class="text-sm">' + periodeStr + '</td><td class="num">' + (a.montant > 0 ? "+" : "") + DB.fmtEUR(a.montant) + '</td><td class="text-sm">' + (a.motif ? LM.escapeHtml(a.motif) : '<span class="text-faint">—</span>') + '</td></tr>';
            }).join("") +
          '</tbody></table></div>' +
          (allAdj.length > historyRows.length ? '<p class="text-sm text-faint">Affichage limité aux 8 plus récents.</p>' : '') +
          '<p class="text-sm text-faint">Ajoutez ou modifiez des primes ponctuelles depuis la fiche détaillée d\'une entrée du journal (bouton "Voir" ci-dessous), ou ajustez la période affichée depuis la page <strong>Primes</strong>.</p>'
          : '<p class="text-sm text-faint">Aucun ajustement manuel enregistré pour ce livreur. Ajoutez-en depuis la fiche détaillée d\'une entrée du journal (bouton "Voir" ci-dessous) ou depuis la page <strong>Primes</strong>.</p>') +
      '</div>';
    }

    function miniStat(label, value) {
      return '<div><div class="text-sm text-faint">' + label + '</div><div style="font-weight:700;font-size:1.05rem;">' + value + '</div></div>';
    }

    // ---------------- Véhicule & réparations ----------------
    function vehiculeCardHtml(liv) {
      var veh = liv.vehiculeId ? DB.get("vehicules", liv.vehiculeId) : null;
      if (!veh) {
        return '<div class="card"><h2>Véhicule</h2><p class="text-sm text-faint">Aucun véhicule assigné à ce livreur.</p></div>';
      }
      var statut = VEH_STATUTS_LOCAL[veh.statut] || VEH_STATUTS_LOCAL.service;
      var tickets = DB.list("ticketsReparation").filter(function (t) { return t.materielType === "vehicule" && t.materielId === veh.id; });
      var ouverts = tickets.filter(function (t) { return t.statut === "nouveau" || t.statut === "en_cours"; })
        .sort(function (a, b) { return (b.dateCreation || "").localeCompare(a.dateCreation || ""); });
      var recents = tickets.filter(function (t) { return t.statut === "termine"; })
        .sort(function (a, b) { return (b.dateFin || "").localeCompare(a.dateFin || ""); }).slice(0, 5);
      var nbTerminees = tickets.filter(function (t) { return t.statut === "termine"; }).length;

      return '<div class="card">' +
        '<div class="card-header"><div><h2>Véhicule assigné</h2><p>' + LM.escapeHtml(veh.plaque) + ' — ' + LM.escapeHtml(veh.type || "") + '</p></div>' +
          '<span class="badge ' + statut.cls + '">' + statut.label + '</span>' +
        '</div>' +
        '<div class="grid grid-4" style="margin-bottom:16px;">' +
          miniStat("Kilométrage", DB.fmtNum(veh.km)) +
          miniStat("Prochain entretien", DB.fmtDate(veh.prochainEntretien)) +
          miniStat("Tickets ouverts", DB.fmtNum(ouverts.length)) +
          miniStat("Réparations terminées", DB.fmtNum(nbTerminees)) +
        '</div>' +
        (ouverts.length ?
          '<h3>Tickets ouverts</h3>' +
          '<div class="table-wrap" style="margin-bottom:16px;"><table><thead><tr><th>Titre</th><th>Priorité</th><th>Statut</th><th>Créé le</th></tr></thead><tbody>' +
            ouverts.map(function (t) {
              return '<tr><td>' + LM.escapeHtml(t.titre) + '</td><td><span class="badge ' + (PRIORITE_CLS[t.priorite] || "badge-info") + '">' + LM.escapeHtml(t.priorite) + '</span></td><td>' + (STATUT_TICKET_LABELS[t.statut] || t.statut) + '</td><td class="text-sm">' + DB.fmtDate(t.dateCreation) + '</td></tr>';
            }).join("") +
          '</tbody></table></div>' : '') +
        (recents.length ?
          '<h3>Réparations récentes</h3>' +
          '<div class="table-wrap"><table><thead><tr><th>Titre</th><th>Terminé le</th><th class="num">Coût</th></tr></thead><tbody>' +
            recents.map(function (t) {
              return '<tr><td>' + LM.escapeHtml(t.titre) + '</td><td class="text-sm">' + DB.fmtDate(t.dateFin) + '</td><td class="num">' + (t.cout !== "" && t.cout !== undefined && t.cout !== null ? DB.fmtEUR(t.cout) : "—") + '</td></tr>';
            }).join("") +
          '</tbody></table></div>' :
          (ouverts.length ? '' : '<p class="text-sm text-faint">Aucun historique de réparation pour ce véhicule.</p>')) +
      '</div>';
    }

    // ---------------- Journal ----------------
    function journalCardHtml() {
      return '<div class="card">' +
        '<div class="card-header"><div><h2>Journal des livraisons</h2><p>Entrées de ce livreur sur la période sélectionnée. Le retard est lié aux signalements de la page <strong>Retards</strong>.</p></div></div>' +
        '<div class="table-wrap"><table><thead><tr><th>Date</th><th>Entrepôt</th><th class="num">Livraisons</th><th class="num">Bacs</th><th class="num">Km</th><th>Retard</th><th></th></tr></thead><tbody id="perfJournalBody"></tbody></table></div>' +
        '<div class="flex gap-10" style="margin-top:14px;align-items:center;justify-content:flex-end;" id="perfJournalPager"></div>' +
      '</div>';
    }

    function mountJournal(rows) {
      var sorted = rows.slice().sort(function (a, b) { return b.date.localeCompare(a.date); });
      var totalPages = Math.max(1, Math.ceil(sorted.length / JOURNAL_PAGE_SIZE));
      if (journalPage > totalPages) journalPage = totalPages;
      var pageRows = sorted.slice((journalPage - 1) * JOURNAL_PAGE_SIZE, journalPage * JOURNAL_PAGE_SIZE);

      var tbody = document.getElementById("perfJournalBody");
      if (!pageRows.length) {
        tbody.innerHTML = '<tr class="empty-row"><td colspan="7">Aucune livraison sur cette période.</td></tr>';
      } else {
        tbody.innerHTML = pageRows.map(function (r) {
          var entLabel = r.entrepotId ? (DB.entrepotNom(r.entrepotId) || r.entrepotNom || "Entrepôt inconnu") : (r.entrepotNom || "Non renseigné");
          var ret = DB.retardPourLivraison(r.id);
          var n = ret ? (Number(ret.nbLivraisonsRetard) || 0) : 0;
          return '<tr>' +
            '<td>' + DB.fmtDate(r.date) + '</td>' +
            '<td>' + LM.escapeHtml(entLabel) + '</td>' +
            '<td class="num">' + DB.fmtNum(r.nbLivraisons) + '</td>' +
            '<td class="num">' + DB.fmtNum(r.nbBacs) + '</td>' +
            '<td class="num">' + DB.fmtNum(r.km) + '</td>' +
            '<td>' + (n > 0 ? '<span class="badge badge-warning">' + n + ' en retard</span>' : '<span class="text-faint">Aucun</span>') + '</td>' +
            '<td class="actions">' +
              '<button class="btn btn-ghost btn-sm btn-icon" data-view="' + r.id + '" title="Voir le détail">' + LM.icon("eye") + '</button>' +
              '<button class="btn btn-ghost btn-sm btn-icon" data-retard="' + r.id + '" title="Gérer le retard">' + LM.icon("retard") + '</button>' +
            '</td>' +
          '</tr>';
        }).join("");
        tbody.querySelectorAll("[data-view]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var r = DB.get("livraisons", btn.getAttribute("data-view"));
            if (r && window.LMApp && window.LMApp.openLivraisonDetail) window.LMApp.openLivraisonDetail(r, renderBody);
          });
        });
        tbody.querySelectorAll("[data-retard]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var r = DB.get("livraisons", btn.getAttribute("data-retard"));
            if (r && window.LMApp && window.LMApp.openRetardForm) window.LMApp.openRetardForm(r, renderBody);
          });
        });
      }

      var pager = document.getElementById("perfJournalPager");
      pager.innerHTML =
        '<button class="btn btn-secondary btn-sm" id="perfPrevPage"' + (journalPage <= 1 ? " disabled" : "") + '>Précédent</button>' +
        '<span class="text-sm">Page ' + journalPage + ' / ' + totalPages + '</span>' +
        '<button class="btn btn-secondary btn-sm" id="perfNextPage"' + (journalPage >= totalPages ? " disabled" : "") + '>Suivant</button>';
      var prevBtn = document.getElementById("perfPrevPage"), nextBtn = document.getElementById("perfNextPage");
      if (prevBtn) prevBtn.addEventListener("click", function () { journalPage--; renderBody(); });
      if (nextBtn) nextBtn.addEventListener("click", function () { journalPage++; renderBody(); });
    }
  }

  // ------------------------------------------------------------------
  // Export PDF : une ou plusieurs fiches de performance (période + livreurs au choix, par défaut
  // le livreur actuellement affiché), chaque livreur démarrant sur une nouvelle page à l'impression.
  // Les sections (profil, KPI, primes, véhicule/réparations, journal) sont sélectionnables.
  // ------------------------------------------------------------------
  function openExportPerfPdfModal(livreurs) {
    LM.openModal({
      title: "Exporter la fiche de performance en PDF",
      wide: true,
      bodyHtml:
        '<p class="text-sm text-faint" style="margin-top:0;">Générez une fiche imprimable pour un ou plusieurs livreurs, sur la période de votre choix.</p>' +
        '<div class="form-row">' +
          '<div class="field"><label>Du</label><input type="date" id="perfPdfStart" value="' + period.start + '" /></div>' +
          '<div class="field"><label>Au</label><input type="date" id="perfPdfEnd" value="' + period.end + '" /></div>' +
        '</div>' +
        '<div class="field">' +
          '<label>Livreurs à inclure</label>' +
          '<div class="flex gap-10" style="margin-bottom:8px;">' +
            '<button type="button" class="btn btn-ghost btn-sm" id="perfPdfAll">Tout cocher</button>' +
            '<button type="button" class="btn btn-ghost btn-sm" id="perfPdfNone">Tout décocher</button>' +
          '</div>' +
          '<div class="planning-livreur-chip-list">' +
            livreurs.map(function (l) {
              return '<label class="planning-livreur-check"><input type="checkbox" data-perfpdfliv="' + l.id + '"' + (l.id === selectedLivreurId ? " checked" : "") + ' /> ' + LM.escapeHtml(DB.livreurNomComplet(l)) + '</label>';
            }).join("") +
          '</div>' +
        '</div>' +
        '<div class="field">' +
          '<label>Sections à inclure</label>' +
          [
            { key: "profil", label: "Profil & informations" },
            { key: "kpis", label: "Indicateurs clés (KPI)" },
            { key: "primes", label: "Primes" },
            { key: "vehicule", label: "Véhicule & réparations" },
            { key: "journal", label: "Journal des livraisons" }
          ].map(function (s) {
            return '<label class="checkbox-row" style="margin-bottom:8px;"><input type="checkbox" data-perfpdfsection="' + s.key + '" checked /> ' + s.label + '</label>';
          }).join("") +
        '</div>',
      footerHtml:
        '<button class="btn btn-secondary" id="cancelBtn">Annuler</button>' +
        '<button class="btn btn-pdf" id="perfPdfGo">' + LM.icon("file") + ' Générer le PDF</button>',
      onMount: function (modal) {
        modal.querySelector("#cancelBtn").addEventListener("click", LM.closeModal);
        modal.querySelector("#perfPdfAll").addEventListener("click", function () {
          modal.querySelectorAll("[data-perfpdfliv]").forEach(function (cb) { cb.checked = true; });
        });
        modal.querySelector("#perfPdfNone").addEventListener("click", function () {
          modal.querySelectorAll("[data-perfpdfliv]").forEach(function (cb) { cb.checked = false; });
        });
        modal.querySelector("#perfPdfGo").addEventListener("click", function () {
          var start = modal.querySelector("#perfPdfStart").value;
          var end = modal.querySelector("#perfPdfEnd").value;
          if (!start || !end || start > end) { LM.toast("Période invalide.", "danger"); return; }
          var selectedIds = Array.prototype.slice.call(modal.querySelectorAll("[data-perfpdfliv]"))
            .filter(function (cb) { return cb.checked; })
            .map(function (cb) { return cb.getAttribute("data-perfpdfliv"); });
          if (!selectedIds.length) { LM.toast("Sélectionnez au moins un livreur.", "danger"); return; }
          var sections = {};
          Array.prototype.slice.call(modal.querySelectorAll("[data-perfpdfsection]")).forEach(function (cb) {
            sections[cb.getAttribute("data-perfpdfsection")] = cb.checked;
          });
          if (!Object.keys(sections).some(function (k) { return sections[k]; })) { LM.toast("Sélectionnez au moins une section à inclure.", "danger"); return; }
          var selectedLivreurs = selectedIds.map(function (id) { return DB.get("livreurs", id); }).filter(Boolean)
            .sort(function (a, b) { return DB.livreurNomComplet(a).localeCompare(DB.livreurNomComplet(b), "fr"); });
          LM.closeModal();
          exportPerfPdf(selectedLivreurs, start, end, sections);
        });
      }
    });
  }

  function pdfEtatBadge(cls, label) { return '<span class="pr-badge ' + cls + '">' + label + '</span>'; }

  function exportPerfPdf(selectedLivreurs, start, end, sections) {
    var periodeLabel = "Période : " + DB.fmtDate(start) + " → " + DB.fmtDate(end);
    var sectionLabels = { profil: "Profil", kpis: "KPI", primes: "Primes", vehicule: "Véhicule", journal: "Journal" };
    var sectionsIncluses = Object.keys(sectionLabels).filter(function (k) { return sections[k]; }).map(function (k) { return sectionLabels[k]; }).join(", ");
    var subtitle = LM.escapeHtml(periodeLabel + "\n" + selectedLivreurs.length + " livreur(s) — Sections : " + sectionsIncluses);

    var body = selectedLivreurs.map(function (liv, idx) {
      var rows = DB.list("livraisons").filter(function (r) { return r.livreurId === liv.id && r.date >= start && r.date <= end; });
      var statut = STATUTS_LIV[liv.statut] || STATUTS_LIV.inactif;
      var statutBadgeCls = { actif: "pr-badge-success", conge: "pr-badge-info", arret: "pr-badge-warning", inactif: "pr-badge-neutral" };

      var html = '<div' + (idx > 0 ? ' class="pr-pagebreak"' : '') + '>';
      html += '<div class="pr-section-title" style="margin-top:' + (idx > 0 ? "0" : "20px") + ';">' + LM.escapeHtml(DB.livreurNomComplet(liv)) + ' ' + pdfEtatBadge(statutBadgeCls[liv.statut] || "pr-badge-neutral", statut.label) + '</div>';

      if (sections.profil) {
        var ents = (liv.entrepotIds || []).map(function (id) { return DB.get("entrepots", id); }).filter(Boolean);
        var veh = liv.vehiculeId ? DB.get("vehicules", liv.vehiculeId) : null;
        var infos = [
          "Zone : " + (liv.zone ? LM.escapeHtml(liv.zone) : "—"),
          liv.dateEmbauche ? "Embauché(e) le " + DB.fmtDate(liv.dateEmbauche) : "",
          "Téléphone : " + (liv.telephone ? LM.escapeHtml(liv.telephone) : "—"),
          "Email : " + (liv.email ? LM.escapeHtml(liv.email) : "—"),
          "Permis : " + (liv.permis ? LM.escapeHtml(liv.permis) : "—"),
          "Entrepôts : " + (ents.length ? ents.map(function (e) { return LM.escapeHtml(e.nom); }).join(", ") : "Non rattaché"),
          "Véhicule : " + (veh ? (LM.escapeHtml(veh.plaque) + " (" + LM.escapeHtml(veh.type || "") + ")") : "Aucun")
        ].filter(Boolean);
        html += '<p style="font-size:11.5px;color:#374151;margin:0 0 14px;">' + infos.join(" &nbsp;·&nbsp; ") + '</p>';
      }

      if (sections.kpis) {
        var nbLivraisons = sumField(rows, "nbLivraisons"), nbBacs = sumField(rows, "nbBacs"), km = sumField(rows, "km"), retard = sumRetard(rows);
        var joursSet = {};
        rows.forEach(function (r) { joursSet[r.date] = true; });
        var nbJours = Object.keys(joursSet).length;
        var moyenneBacsJour = nbJours ? nbBacs / nbJours : 0;
        var ranking = computeTeamRanking(start, end);
        var rankIdx = ranking.findIndex(function (r) { return r.id === liv.id; });
        var rankLabel = rankIdx >= 0 ? ("#" + (rankIdx + 1) + " / " + ranking.length) : "—";
        var tauxRetard = nbLivraisons ? (retard / nbLivraisons * 100) : 0;
        html += '<div class="pr-kpis">' +
            '<div class="pr-kpi"><div class="pr-kpi-label">Livraisons</div><div class="pr-kpi-value">' + DB.fmtNum(nbLivraisons) + '</div></div>' +
            '<div class="pr-kpi"><div class="pr-kpi-label">Bacs livrés</div><div class="pr-kpi-value">' + DB.fmtNum(nbBacs) + '</div></div>' +
            '<div class="pr-kpi"><div class="pr-kpi-label">Km parcourus</div><div class="pr-kpi-value">' + DB.fmtNum(Math.round(km)) + '</div></div>' +
            '<div class="pr-kpi"><div class="pr-kpi-label">Livraisons en retard</div><div class="pr-kpi-value">' + DB.fmtNum(retard) + '</div></div>' +
          '</div>' +
          '<div class="pr-kpis">' +
            '<div class="pr-kpi"><div class="pr-kpi-label">Jours travaillés</div><div class="pr-kpi-value">' + DB.fmtNum(nbJours) + '</div></div>' +
            '<div class="pr-kpi"><div class="pr-kpi-label">Moyenne bacs / jour</div><div class="pr-kpi-value">' + moyenneBacsJour.toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + '</div></div>' +
            '<div class="pr-kpi"><div class="pr-kpi-label">Rang équipe (bacs livrés)</div><div class="pr-kpi-value">' + rankLabel + '</div></div>' +
            '<div class="pr-kpi"><div class="pr-kpi-label">Taux de retard</div><div class="pr-kpi-value">' + (nbLivraisons ? tauxRetard.toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " %" : "—") + '</div></div>' +
          '</div>';
      }

      if (sections.primes) {
        var calc = DB.computePrimePeriode(liv.id, start, end);
        var allAdj = DB.list("primesAjustements").filter(function (a) { return a.livreurId === liv.id; })
          .slice().sort(function (a, b) { return (b.periodeDebut || "").localeCompare(a.periodeDebut || ""); });
        var historyRows = allAdj.slice(0, 8);
        html += '<p style="font-size:12px;font-weight:700;margin:14px 0 6px;">Primes (' + DB.fmtDate(start) + ' → ' + DB.fmtDate(end) + ')</p>' +
          '<div class="pr-kpis">' +
            '<div class="pr-kpi"><div class="pr-kpi-label">Jours travaillés</div><div class="pr-kpi-value">' + DB.fmtNum(calc.nbJours) + '</div></div>' +
            '<div class="pr-kpi"><div class="pr-kpi-label">Palier atteint</div><div class="pr-kpi-value" style="font-size:14px;">' + LM.escapeHtml(calc.tierLabel) + '</div></div>' +
            '<div class="pr-kpi"><div class="pr-kpi-label">Prime barème</div><div class="pr-kpi-value">' + DB.fmtEUR(calc.bareme) + '</div></div>' +
            '<div class="pr-kpi"><div class="pr-kpi-label">Total (barème + ajustements)</div><div class="pr-kpi-value">' + DB.fmtEUR(calc.total) + '</div></div>' +
          '</div>' +
          (historyRows.length ?
            '<table class="pr-table"><thead><tr><th>Période</th><th>Montant</th><th>Motif</th></tr></thead><tbody>' +
              historyRows.map(function (a) {
                var periodeStr = a.periodeDebut === a.periodeFin ? DB.fmtDate(a.periodeDebut) : (DB.fmtDate(a.periodeDebut) + " → " + DB.fmtDate(a.periodeFin));
                return '<tr><td>' + periodeStr + '</td><td>' + (a.montant > 0 ? "+" : "") + DB.fmtEUR(a.montant) + '</td><td>' + (a.motif ? LM.escapeHtml(a.motif) : "—") + '</td></tr>';
              }).join("") +
            '</tbody></table>' +
            (allAdj.length > historyRows.length ? '<p class="pr-desc">Affichage limité aux 8 ajustements les plus récents (sur ' + allAdj.length + ').</p>' : '')
            : '<p class="pr-empty">Aucun ajustement manuel enregistré pour ce livreur.</p>');
      }

      if (sections.vehicule) {
        var veh2 = liv.vehiculeId ? DB.get("vehicules", liv.vehiculeId) : null;
        html += '<p style="font-size:12px;font-weight:700;margin:14px 0 6px;">Véhicule &amp; réparations</p>';
        if (!veh2) {
          html += '<p class="pr-empty">Aucun véhicule assigné à ce livreur.</p>';
        } else {
          var vehStatutCls = { service: "pr-badge-success", maintenance: "pr-badge-warning", hors_service: "pr-badge-danger" };
          var vehStatutLabel = (VEH_STATUTS_LOCAL[veh2.statut] || VEH_STATUTS_LOCAL.service).label;
          var tickets = DB.list("ticketsReparation").filter(function (t) { return t.materielType === "vehicule" && t.materielId === veh2.id; });
          var ouverts = tickets.filter(function (t) { return t.statut === "nouveau" || t.statut === "en_cours"; })
            .sort(function (a, b) { return (b.dateCreation || "").localeCompare(a.dateCreation || ""); });
          var recents = tickets.filter(function (t) { return t.statut === "termine"; })
            .sort(function (a, b) { return (b.dateFin || "").localeCompare(a.dateFin || ""); }).slice(0, 5);
          html += '<p style="font-size:11.5px;color:#374151;margin:0 0 10px;">' + LM.escapeHtml(veh2.plaque) + ' (' + LM.escapeHtml(veh2.type || "") + ') ' + pdfEtatBadge(vehStatutCls[veh2.statut] || "pr-badge-neutral", vehStatutLabel) + ' &nbsp;·&nbsp; Kilométrage : ' + DB.fmtNum(veh2.km) + ' &nbsp;·&nbsp; Prochain entretien : ' + (veh2.prochainEntretien ? DB.fmtDate(veh2.prochainEntretien) : "—") + '</p>';
          if (ouverts.length) {
            html += '<table class="pr-table"><thead><tr><th>Ticket ouvert</th><th>Priorité</th><th>Statut</th><th>Créé le</th></tr></thead><tbody>' +
              ouverts.map(function (t) {
                return '<tr><td>' + LM.escapeHtml(t.titre) + '</td><td><span class="pr-badge ' + (PRIORITE_CLS[t.priorite] === "badge-danger" ? "pr-badge-danger" : PRIORITE_CLS[t.priorite] === "badge-warning" ? "pr-badge-warning" : "pr-badge-info") + '">' + LM.escapeHtml(t.priorite) + '</span></td><td>' + (STATUT_TICKET_LABELS[t.statut] || t.statut) + '</td><td>' + DB.fmtDate(t.dateCreation) + '</td></tr>';
              }).join("") +
            '</tbody></table>';
          }
          if (recents.length) {
            html += '<table class="pr-table" style="margin-top:8px;"><thead><tr><th>Réparation terminée</th><th>Terminé le</th><th>Coût</th></tr></thead><tbody>' +
              recents.map(function (t) {
                return '<tr><td>' + LM.escapeHtml(t.titre) + '</td><td>' + DB.fmtDate(t.dateFin) + '</td><td>' + (t.cout !== "" && t.cout !== undefined && t.cout !== null ? DB.fmtEUR(t.cout) : "—") + '</td></tr>';
              }).join("") +
            '</tbody></table>';
          }
          if (!ouverts.length && !recents.length) html += '<p class="pr-empty">Aucun historique de réparation pour ce véhicule.</p>';
        }
      }

      if (sections.journal) {
        var sortedRows = rows.slice().sort(function (a, b) { return a.date.localeCompare(b.date); });
        html += '<p style="font-size:12px;font-weight:700;margin:14px 0 6px;">Journal des livraisons (' + sortedRows.length + ')</p>';
        if (!sortedRows.length) {
          html += '<p class="pr-empty">Aucune livraison sur cette période.</p>';
        } else {
          html += '<table class="pr-table"><thead><tr><th>Date</th><th>Entrepôt</th><th>Livraisons</th><th>Bacs</th><th>Km</th><th>Retard</th></tr></thead><tbody>' +
            sortedRows.map(function (r) {
              var entLabel = r.entrepotId ? (DB.entrepotNom(r.entrepotId) || r.entrepotNom || "Entrepôt inconnu") : (r.entrepotNom || "Non renseigné");
              var ret = DB.retardPourLivraison(r.id);
              var n = ret ? (Number(ret.nbLivraisonsRetard) || 0) : 0;
              return '<tr><td>' + DB.fmtDate(r.date) + '</td><td>' + LM.escapeHtml(entLabel) + '</td><td>' + DB.fmtNum(r.nbLivraisons) + '</td><td>' + DB.fmtNum(r.nbBacs) + '</td><td>' + DB.fmtNum(r.km) + '</td><td>' + (n > 0 ? pdfEtatBadge("pr-badge-warning", n + " en retard") : '<span class="pr-desc">Aucun</span>') + '</td></tr>';
            }).join("") +
          '</tbody></table>';
        }
      }

      html += '</div>';
      return html;
    }).join("");

    LM.printReport("Fiche de performance livreur", body, { subtitle: subtitle });
  }

  function kpi(iconName, label, value, extraHtml) {
    return '<div class="kpi"><div class="kpi-label"><span class="kpi-icon">' + LM.icon(iconName) + '</span>' + label + '</div><div class="kpi-value">' + value + '</div>' + (extraHtml || "") + '</div>';
  }
})();

/* ==== js/annexes.js ==== */
/*! annexes.js - Page Annexes : listes de référence personnalisables (catégories, types, parties de contrôle...) */
(function () {
  "use strict";

  App.registerPage("annexes", {
    title: "Annexes",
    subtitle: "Listes de référence personnalisables",
    render: render
  });

  function render(content) {
    content.innerHTML =
      '<div class="card" style="margin-bottom:18px;">' +
        '<div class="card-header" style="margin-top:0;"><div><h2>Listes de référence</h2>' +
          '<p>Personnalisez ici les listes utilisées dans les formulaires de l\'application. Modifiez un libellé directement dans son champ, ou ajoutez de nouvelles entrées pour être plus précis — par exemple des catégories dédiées à des pièces mécaniques spécifiques.</p>' +
        '</div></div>' +
      '</div>' +
      '<div class="grid grid-3" id="annexesGrid" style="align-items:start;"></div>';

    var grid = document.getElementById("annexesGrid");

    var LISTES = [
      {
        name: "categoriesMateriel", title: "Catégories de matériel",
        subtitle: "Utilisées dans Matériel > Autre matériel pour classer bacs, chariots, scanners, pièces mécaniques…",
        usage: function (key) { return DB.list("materiels").filter(function (m) { return m.categorie === key; }).length; },
        usageLabel: "matériel(s)"
      },
      {
        name: "typesVehicule", title: "Types de véhicule",
        subtitle: "Utilisés dans Matériel > Véhicules pour qualifier chaque véhicule du parc.",
        usage: function (key) { return DB.list("vehicules").filter(function (v) { return v.type === key; }).length; },
        usageLabel: "véhicule(s)"
      },
      {
        name: "partiesControle", title: "Parties contrôlées (contrôle véhicule)",
        subtitle: "Proposées dans Réparations lors de la création d'un contrôle général de véhicule (freins, direction, structure…).",
        usage: function (key) {
          return DB.list("ticketsReparation").filter(function (t) {
            return (t.checklist || []).some(function (c) { return c.key === key; });
          }).length;
        },
        usageLabel: "contrôle(s)"
      },
      {
        name: "motifsRetard", title: "Justificatifs de retard",
        subtitle: "Proposés dans Retards lors de la saisie d'un retard, pour chaque client concerné (jusqu'à 3 justificatifs par client).",
        usage: function (key) {
          return DB.list("retards").filter(function (r) {
            return (r.clients || []).some(function (c) { return (c.justifications || []).indexOf(key) !== -1; });
          }).length;
        },
        usageLabel: "retard(s)"
      }
    ];

    LISTES.forEach(function (def) { renderListeCard(grid, def); });

    // Types d'absence (page Planning) : une carte à part car chaque entrée porte une couleur en
    // plus de son libellé, reprise sur la grille du planning et le récapitulatif "Effectif du jour".
    renderTypesAbsenceCard(grid);
  }

  function renderListeCard(container, def) {
    var box = document.createElement("div");
    box.className = "card";
    container.appendChild(box);
    paint();

    function paint() {
      var items = DB.listeItems(def.name);
      box.innerHTML =
        '<div class="card-header" style="margin-top:0;"><div><h3>' + LM.escapeHtml(def.title) + '</h3><p class="text-sm">' + LM.escapeHtml(def.subtitle) + '</p></div></div>' +
        '<div class="flex" style="flex-direction:column;gap:8px;margin-bottom:14px;" id="rows-' + def.name + '"></div>' +
        '<div class="form-row" style="align-items:flex-end;margin-bottom:0;">' +
          '<div class="field mb-0" style="flex:1;"><label>Nouvelle entrée</label><input type="text" class="new-item-input" placeholder="ex : Pièces de freinage" /></div>' +
          '<div class="field mb-0"><button type="button" class="btn btn-secondary btn-sm add-item-btn">' + LM.icon("plus") + ' Ajouter</button></div>' +
        '</div>';

      var rowsWrap = box.querySelector("#rows-" + def.name);
      rowsWrap.innerHTML = items.length ? items.map(function (it) {
        return '<div class="flex gap-8" style="align-items:center;">' +
          '<input type="text" class="table-input li-label-input" value="' + LM.escapeHtml(it.label) + '" data-key="' + it.key + '" style="flex:1;" />' +
          '<button type="button" class="btn btn-ghost btn-sm btn-icon" data-del="' + it.key + '" title="Supprimer cette entrée">' + LM.icon("trash") + '</button>' +
        '</div>';
      }).join("") : '<p class="text-sm text-faint" style="margin:0;">Aucune entrée pour le moment.</p>';

      rowsWrap.querySelectorAll(".li-label-input").forEach(function (inp) {
        inp.addEventListener("change", function () {
          var key = inp.getAttribute("data-key");
          var val = inp.value.trim();
          if (!val) { LM.toast("Le libellé ne peut pas être vide.", "danger"); paint(); return; }
          DB.updateListeItem(def.name, key, val);
          LM.toast("Entrée mise à jour.", "success");
        });
      });

      rowsWrap.querySelectorAll("[data-del]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var key = btn.getAttribute("data-del");
          var item = items.find(function (i) { return i.key === key; });
          if (!item) return;
          var count = def.usage ? def.usage(key) : 0;
          var msg = "Supprimer l'entrée <strong>" + LM.escapeHtml(item.label) + "</strong> ?" +
            (count ? " " + count + " " + def.usageLabel + " l'utilisent actuellement : ils conserveront leur valeur enregistrée, mais elle n'apparaîtra plus dans cette liste." : "");
          LM.confirmDialog(msg, function () {
            DB.removeListeItem(def.name, key);
            LM.toast("Entrée supprimée.", "success");
            paint();
          });
        });
      });

      var addBtn = box.querySelector(".add-item-btn");
      var addInput = box.querySelector(".new-item-input");
      function doAdd() {
        var val = addInput.value.trim();
        if (!val) { LM.toast("Saisissez un libellé avant d'ajouter.", "danger"); return; }
        var dup = items.some(function (i) { return DB.normalizeStr(i.label) === DB.normalizeStr(val); });
        if (dup) { LM.toast("Cette entrée existe déjà dans la liste.", "danger"); return; }
        DB.addListeItem(def.name, val);
        LM.toast("Entrée ajoutée.", "success");
        paint();
      }
      addBtn.addEventListener("click", doAdd);
      addInput.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); doAdd(); } });
    }
  }

  // ------------------------------------------------------------------
  // Carte "Types d'absence" (page Planning) : variante de renderListeCard où chaque entrée porte
  // en plus une couleur (hex), reprise sur la grille du planning et le récapitulatif "Effectif
  // du jour" pour repérer chaque type d'un coup d'œil. Les types "Travail" et "Repos" ne sont pas
  // gérés ici : ce sont des jours travaillés/de repos fixes, pas des motifs d'absence.
  var TYPES_ABSENCE_PALETTE = ["#2f7bd6", "#14b8a6", "#d64545", "#d68a13", "#3454d1", "#9333ea", "#0d9488", "#db2777", "#65a30d", "#ea580c"];

  function renderTypesAbsenceCard(container) {
    var box = document.createElement("div");
    box.className = "card";
    container.appendChild(box);
    paint();

    function usage(key) {
      var n = DB.list("planningEntrees").filter(function (e) { return e.type === key; }).length;
      n += DB.list("demandesAbsence").filter(function (d) { return d.type === key; }).length;
      return n;
    }

    function paint() {
      var items = DB.listeItems("typesAbsence");
      box.innerHTML =
        '<div class="card-header" style="margin-top:0;"><div><h3>Types d\'absence</h3><p class="text-sm">Proposés dans Planning (case du planning et « Nouvelle demande »), avec une couleur personnalisable pour chaque type.</p></div></div>' +
        '<div class="flex" style="flex-direction:column;gap:8px;margin-bottom:14px;" id="rows-typesAbsence"></div>' +
        '<div class="form-row" style="align-items:flex-end;margin-bottom:0;">' +
          '<div class="field mb-0"><label>Couleur</label><input type="color" id="newTypeAbsenceColor" value="' + TYPES_ABSENCE_PALETTE[items.length % TYPES_ABSENCE_PALETTE.length] + '" /></div>' +
          '<div class="field mb-0" style="flex:1;"><label>Nouvelle entrée</label><input type="text" class="new-item-input" placeholder="ex : Congé sans solde" /></div>' +
          '<div class="field mb-0"><button type="button" class="btn btn-secondary btn-sm add-item-btn">' + LM.icon("plus") + ' Ajouter</button></div>' +
        '</div>';

      var rowsWrap = box.querySelector("#rows-typesAbsence");
      rowsWrap.innerHTML = items.length ? items.map(function (it) {
        return '<div class="flex gap-8" style="align-items:center;">' +
          '<input type="color" class="li-color-input" value="' + (it.color || "#3454d1") + '" data-key="' + it.key + '" title="Couleur" />' +
          '<input type="text" class="table-input li-label-input" value="' + LM.escapeHtml(it.label) + '" data-key="' + it.key + '" style="flex:1;" />' +
          '<button type="button" class="btn btn-ghost btn-sm btn-icon" data-del="' + it.key + '" title="Supprimer cette entrée">' + LM.icon("trash") + '</button>' +
        '</div>';
      }).join("") : '<p class="text-sm text-faint" style="margin:0;">Aucune entrée pour le moment.</p>';

      rowsWrap.querySelectorAll(".li-label-input").forEach(function (inp) {
        inp.addEventListener("change", function () {
          var key = inp.getAttribute("data-key");
          var val = inp.value.trim();
          if (!val) { LM.toast("Le libellé ne peut pas être vide.", "danger"); paint(); return; }
          DB.updateListeItem("typesAbsence", key, val);
          LM.toast("Entrée mise à jour.", "success");
        });
      });
      rowsWrap.querySelectorAll(".li-color-input").forEach(function (inp) {
        inp.addEventListener("change", function () {
          var key = inp.getAttribute("data-key");
          DB.setListeItemColor("typesAbsence", key, inp.value);
          LM.toast("Couleur mise à jour.", "success");
        });
      });

      rowsWrap.querySelectorAll("[data-del]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var key = btn.getAttribute("data-del");
          var item = items.find(function (i) { return i.key === key; });
          if (!item) return;
          var count = usage(key);
          var msg = "Supprimer le type <strong>" + LM.escapeHtml(item.label) + "</strong> ?" +
            (count ? " " + count + " case(s)/demande(s) de planning l'utilisent actuellement : elles conserveront leur valeur enregistrée, mais elle n'apparaîtra plus dans cette liste (affichage générique)." : "");
          LM.confirmDialog(msg, function () {
            DB.removeListeItem("typesAbsence", key);
            LM.toast("Entrée supprimée.", "success");
            paint();
          });
        });
      });

      var addBtn = box.querySelector(".add-item-btn");
      var addInput = box.querySelector(".new-item-input");
      var addColorInput = box.querySelector("#newTypeAbsenceColor");
      function doAdd() {
        var val = addInput.value.trim();
        if (!val) { LM.toast("Saisissez un libellé avant d'ajouter.", "danger"); return; }
        var dup = items.some(function (i) { return DB.normalizeStr(i.label) === DB.normalizeStr(val); });
        if (dup) { LM.toast("Cette entrée existe déjà dans la liste.", "danger"); return; }
        DB.addListeItem("typesAbsence", val, { color: addColorInput.value });
        LM.toast("Entrée ajoutée.", "success");
        paint();
      }
      addBtn.addEventListener("click", doAdd);
      addInput.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); doAdd(); } });
    }
  }
})();

/* ==== js/planning.js ==== */
/*! planning.js - Planning hebdomadaire des livreurs : grille travail/congés/absences, historique
    des demandes et réglages par défaut (horaires, pause, dimanche travaillé). */
(function () {
  "use strict";

  // Types de journée : "Travail" et "Repos" sont fixes (jours travaillés/de repos, pas des
  // absences). Tous les autres types (CP, RTT, arrêt maladie, absence injustifiée, jour férié,
  // et toute entrée ajoutée par l'utilisateur) sont une liste de référence personnalisable
  // depuis la page Annexes (DB.listeItems("typesAbsence")), chacun avec sa propre couleur (hex)
  // reprise sur la grille du planning et le récapitulatif "Effectif du jour".
  var FIXED_TYPES = {
    travail: { label: "Travail", short: "Travail", cls: "pln-travail", badgeCls: "badge-success" },
    repos: { label: "Repos", short: "Repos", cls: "pln-repos", badgeCls: "badge-muted" }
  };
  var FALLBACK_COLOR = "#9aa1b1"; // gris "text-faint", pour un type d'absence supprimé depuis Annexes

  function absenceTypes() { return DB.listeItems("typesAbsence"); }
  // Tous les types utilisables dans le sélecteur "Type de journée" de la grille (travail/repos +
  // absences), et la seule liste des motifs d'absence (utilisée par "Nouvelle demande").
  function allTypeKeys() { return ["travail", "repos"].concat(absenceTypes().map(function (i) { return i.key; })); }
  function motifTypeKeys() { return absenceTypes().map(function (i) { return i.key; }); }

  // Définition d'affichage d'un type de journée, quelle que soit son origine (fixe ou liste de
  // référence) : { label, short, color } — color est absent (undefined) pour travail/repos, qui
  // gardent leurs classes CSS dédiées plutôt qu'une couleur personnalisable.
  function dayTypeDef(key) {
    if (FIXED_TYPES[key]) return FIXED_TYPES[key];
    var item = absenceTypes().filter(function (i) { return i.key === key; })[0];
    if (item) return { label: item.label, short: item.label, color: item.color || FALLBACK_COLOR };
    return { label: "Type supprimé", short: "?", color: FALLBACK_COLOR };
  }

  // Couleur -> fond teinté (alpha) utilisé en style inline pour les cases/puces d'un type
  // d'absence personnalisé (pas de classe CSS dédiée possible, la couleur étant arbitraire).
  function hexToRgb(hex) {
    var h = (hex || "").replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var num = parseInt(h, 16);
    if (isNaN(num) || h.length !== 6) return { r: 154, g: 161, b: 177 }; // FALLBACK_COLOR
    return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
  }
  function colorTint(hex, alpha) {
    var rgb = hexToRgb(hex);
    return "rgba(" + rgb.r + "," + rgb.g + "," + rgb.b + "," + alpha + ")";
  }
  // Badge coloré générique pour un type (fixe = classe CSS existante, personnalisé = style
  // inline à partir de sa couleur) — utilisé partout où un type de demande est affiché en badge.
  function typeBadgeHtml(key) {
    var def = dayTypeDef(key);
    if (FIXED_TYPES[key]) return '<span class="badge ' + FIXED_TYPES[key].badgeCls + '">' + LM.escapeHtml(def.label) + '</span>';
    return '<span class="badge" style="background:' + colorTint(def.color, 0.16) + ';color:' + LM.escapeHtml(def.color) + ';">' + LM.escapeHtml(def.label) + '</span>';
  }

  var JOURS_SEMAINE = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];

  var activeTab = "planning";
  var currentWeekStart = mondayOf(DB.todayISO());
  var planningFilters = { entrepot: "" };
  var histFilters = { q: "", type: "" };

  App.registerPage("planning", { title: "Planning", subtitle: "Planning hebdomadaire, demandes d'absence et réglages", render: render });

  function render(content) {
    // Une autre page (ex : contrôle des imports de la page Analyse) peut demander à ouvrir le
    // planning directement sur la semaine d'une date donnée ; on lit puis on efface la demande.
    if (App.pendingPlanningFocus) {
      currentWeekStart = mondayOf(App.pendingPlanningFocus);
      activeTab = "planning";
      App.pendingPlanningFocus = null;
    }
    content.innerHTML =
      '<div class="card">' +
        '<div class="tabs">' +
          '<button class="tab-btn' + (activeTab === "planning" ? " active" : "") + '" data-tab="planning">Planning</button>' +
          '<button class="tab-btn' + (activeTab === "historique" ? " active" : "") + '" data-tab="historique">Historique des demandes</button>' +
          '<button class="tab-btn' + (activeTab === "reglages" ? " active" : "") + '" data-tab="reglages">Paramètres planning</button>' +
        '</div>' +
        '<div id="tabPlanning" class="tab-panel' + (activeTab === "planning" ? " active" : "") + '"></div>' +
        '<div id="tabHistorique" class="tab-panel' + (activeTab === "historique" ? " active" : "") + '"></div>' +
        '<div id="tabReglages" class="tab-panel' + (activeTab === "reglages" ? " active" : "") + '"></div>' +
      '</div>';

    content.querySelectorAll("[data-tab]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        activeTab = btn.getAttribute("data-tab");
        render(content);
      });
    });

    if (activeTab === "planning") renderPlanningTab(document.getElementById("tabPlanning"));
    else if (activeTab === "historique") renderHistoriqueTab(document.getElementById("tabHistorique"));
    else renderReglagesTab(document.getElementById("tabReglages"));
  }

  // ------------------------------------------------------------------
  // Utilitaires de dates ISO "YYYY-MM-DD" (même convention que le reste de l'application).
  // Semaine du lundi au dimanche.
  //
  // Important : on reconstruit la chaîne "YYYY-MM-DD" à partir des composants LOCAUX du Date
  // (getFullYear/getMonth/getDate), jamais via toISOString(). new Date(iso + "T00:00:00") crée
  // un instant à minuit en heure LOCALE ; toISOString() le reconvertit en UTC, ce qui décale le
  // résultat d'un jour dans tout fuseau en avance sur UTC (la France, par exemple, en UTC+1 ou
  // +2). Le symptôme observé : "Semaine actuelle"/"Semaine suivante"/"Semaine précédente"
  // affichaient des dates décalées et dérivaient encore un peu plus à chaque clic, et
  // addDaysIso(iso, 1) pouvait même renvoyer exactement la même date qu'en entrée (le +1 jour
  // de setDate étant annulé par le -1 jour de la conversion UTC), ce qui bloquait toute boucle
  // day += 1 jour — dont celle du bouton "Ajouter la période" pour les demandes d'absence.
  function toIsoLocal(d) {
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + "-" + (m < 10 ? "0" : "") + m + "-" + (day < 10 ? "0" : "") + day;
  }
  function mondayOf(iso) {
    var d = new Date(iso + "T00:00:00");
    var day = d.getDay();
    var diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    return toIsoLocal(d);
  }
  function addDaysIso(iso, n) {
    var d = new Date(iso + "T00:00:00");
    d.setDate(d.getDate() + n);
    return toIsoLocal(d);
  }
  function weekDates(startIso) {
    var arr = [];
    for (var i = 0; i < 7; i++) arr.push(addDaysIso(startIso, i));
    return arr;
  }
  function fmtDayShort(iso) {
    var d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
  }
  // Regroupe une liste de dates ISO en plages consécutives pour un affichage compact
  // (ex : ["2026-08-10","2026-08-11","2026-08-12"] -> "10/08/2026 → 12/08/2026 (3 j)").
  function formatJoursCompact(jours) {
    if (!Array.isArray(jours) || !jours.length) return "—";
    var sorted = jours.slice().sort();
    var ranges = [];
    var rangeStart = sorted[0], prev = sorted[0];
    for (var i = 1; i <= sorted.length; i++) {
      var cur = sorted[i];
      if (cur && addDaysIso(prev, 1) === cur) { prev = cur; continue; }
      ranges.push(rangeStart === prev ? DB.fmtDate(rangeStart) : DB.fmtDate(rangeStart) + " → " + DB.fmtDate(prev));
      rangeStart = cur; prev = cur;
    }
    return ranges.join(", ") + ' <span class="text-faint">(' + sorted.length + ' j)</span>';
  }

  // ------------------------------------------------------------------
  // Onglet Planning : grille hebdomadaire (jours en colonnes, livreurs en lignes)
  // ------------------------------------------------------------------
  function renderPlanningTab(panel) {
    var entrepots = DB.list("entrepots");
    var dates = weekDates(currentWeekStart);
    var weekEnd = dates[6];
    var todayIso = DB.todayISO();

    // Date d'embauche : un livreur n'apparaît pas dans une semaine entièrement antérieure à son
    // embauche (il est compté dans "nonEmbauches" pour l'indiquer sous la grille), et ses jours
    // antérieurs à l'embauche, dans une semaine où il est embauché en cours de route, sont
    // grisés et non modifiables (voir planningCellHtml).
    var nonEmbauches = 0;
    var livreurs = DB.list("livreurs").filter(function (l) {
      if (l.statut === "inactif") return false;
      if (planningFilters.entrepot && !DB.livreurAEntrepot(l, planningFilters.entrepot)) return false;
      if (l.dateEmbauche && l.dateEmbauche > weekEnd) { nonEmbauches++; return false; }
      return true;
    }).sort(function (a, b) { return DB.livreurNomComplet(a).localeCompare(DB.livreurNomComplet(b)); });

    var totalCells = 0;
    livreurs.forEach(function (l) {
      dates.forEach(function (dt) { if (DB.livreurEmbaucheLe(l, dt)) totalCells++; });
    });
    var travailCount = 0, absCount = 0, filled = 0;
    livreurs.forEach(function (l) {
      dates.forEach(function (dt) {
        if (!DB.livreurEmbaucheLe(l, dt)) return;
        var e = DB.planningEntreeFor(l.id, dt);
        if (!e) return;
        filled++;
        if (e.type === "travail") travailCount++;
        else if (e.type !== "repos") absCount++;
      });
    });
    var couverture = totalCells ? Math.round((filled / totalCells) * 100) : 0;

    panel.innerHTML =
      '<div class="grid grid-4" style="margin-top:14px;margin-bottom:18px;">' +
        kpi("livreur", "Livreurs planifiés", DB.fmtNum(livreurs.length)) +
        kpi("check", "Jours travail (semaine)", DB.fmtNum(travailCount)) +
        kpi("alert", "Jours absence / congé", DB.fmtNum(absCount)) +
        kpi("calendar", "Taux de couverture", couverture + "%") +
      '</div>' +
      '<div class="form-row" style="margin-bottom:6px;align-items:flex-end;">' +
        '<div class="field mb-0"><label>Entrepôt</label><select id="plnEnt"><option value="">Tous les entrepôts</option>' +
          entrepots.map(function (e) { return '<option value="' + e.id + '"' + (e.id === planningFilters.entrepot ? " selected" : "") + '>' + LM.escapeHtml(e.nom) + '</option>'; }).join("") +
        '</select></div>' +
        '<div class="field mb-0" style="margin-left:auto;display:flex;gap:8px;">' +
          '<button class="btn btn-pdf" id="btnExportPlanningPdf">' + LM.icon("file") + ' Exporter en PDF</button>' +
          '<button class="btn btn-wand" id="btnProposerPlanning">' + LM.icon("wand") + ' Proposer planning</button>' +
        '</div>' +
      '</div>' +
      '<div class="week-nav">' +
        '<button class="btn btn-secondary btn-sm btn-icon" id="btnPrevWeek" title="Semaine précédente">' + LM.icon("chevronLeft") + '</button>' +
        '<button class="btn btn-secondary btn-sm" id="btnThisWeek">Cette semaine</button>' +
        '<span class="week-nav-label">Semaine du ' + DB.fmtDate(currentWeekStart) + ' au ' + DB.fmtDate(weekEnd) + '</span>' +
        '<button class="btn btn-secondary btn-sm btn-icon" id="btnNextWeek" title="Semaine suivante">' + LM.icon("chevronRight") + '</button>' +
      '</div>' +
      '<div class="planning-scroll"><table class="planning-table">' +
        '<thead>' +
          '<tr><th class="planning-livreur-col">Livreur</th>' +
            dates.map(function (d, i) {
              return '<th' + (d === todayIso ? ' class="pln-today"' : '') + '>' + JOURS_SEMAINE[i] + '<br>' + fmtDayShort(d) + '</th>';
            }).join("") +
          '</tr>' +
          '<tr class="planning-summary-row" id="summaryRow"></tr>' +
        '</thead>' +
        '<tbody id="planningBody"></tbody>' +
      '</table></div>' +
      (nonEmbauches > 0 ?
        '<p class="planning-hire-note">' + LM.icon("calendar") + '<span><strong>' + nonEmbauches + ' livreur' + (nonEmbauches > 1 ? "s" : "") + ' non affiché' + (nonEmbauches > 1 ? "s" : "") + '</strong> : ' + (nonEmbauches > 1 ? "leur date d\'embauche est" : "sa date d\'embauche est") + ' postérieure à cette semaine.</span></p>' : '') +
      '<div class="planning-legend">' +
        '<span class="planning-legend-item"><span class="planning-legend-swatch sw-travail"></span>' + FIXED_TYPES.travail.label + '</span>' +
        '<span class="planning-legend-item"><span class="planning-legend-swatch sw-repos"></span>' + FIXED_TYPES.repos.label + '</span>' +
        absenceTypes().map(function (it) {
          return '<span class="planning-legend-item"><span class="planning-legend-swatch" style="background:' + LM.escapeHtml(it.color || FALLBACK_COLOR) + '"></span>' + LM.escapeHtml(it.label) + '</span>';
        }).join("") +
        '<span class="planning-legend-item"><span class="planning-legend-swatch sw-demande-marker"></span>Issu d\'une demande d\'absence <span class="text-faint">(bordure pointillée)</span></span>' +
        '<span class="planning-legend-item"><span class="planning-legend-swatch sw-prehire"></span>Avant l\'embauche <span class="text-faint">(non modifiable)</span></span>' +
      '</div>';

    document.getElementById("plnEnt").addEventListener("change", function (e) { planningFilters.entrepot = e.target.value; renderPlanningTab(panel); });
    document.getElementById("btnPrevWeek").addEventListener("click", function () { currentWeekStart = addDaysIso(currentWeekStart, -7); renderPlanningTab(panel); });
    document.getElementById("btnNextWeek").addEventListener("click", function () { currentWeekStart = addDaysIso(currentWeekStart, 7); renderPlanningTab(panel); });
    document.getElementById("btnThisWeek").addEventListener("click", function () { currentWeekStart = mondayOf(DB.todayISO()); renderPlanningTab(panel); });
    document.getElementById("btnProposerPlanning").addEventListener("click", openProposerPlanningModal);
    document.getElementById("btnExportPlanningPdf").addEventListener("click", openExportPlanningPdfModal);

    renderBody();
    renderSummaryRow();

    // Ligne "Effectif du jour" isolée dans sa propre fonction (plutôt que calculée une seule
    // fois dans le HTML initial du thead) : on peut ainsi la rafraîchir après CHAQUE
    // modification d'une case (type, horaires...), qu'elle passe par renderBody() ou non, pour
    // qu'elle ne reste jamais périmée par rapport à la grille affichée juste en dessous.
    function renderSummaryRow() {
      var row = document.getElementById("summaryRow");
      if (!row) return;
      row.innerHTML = '<th class="planning-livreur-col psum-row-label">Effectif du jour</th>' +
        dates.map(function (d) { return daySummaryHtml(d); }).join("");
    }

    function renderBody() {
      var tbody = document.getElementById("planningBody");
      if (!livreurs.length) {
        tbody.innerHTML = '<tr class="empty-row"><td colspan="8">Aucun livreur ne correspond aux filtres.</td></tr>';
        return;
      }
      tbody.innerHTML = livreurs.map(function (l) {
        var initials = ((l.prenom || "?")[0] + (l.nom || "?")[0]).toUpperCase();
        return '<tr class="planning-row">' +
          '<td class="planning-livreur-col" data-livreur="' + l.id + '" title="Voir le récapitulatif de ' + LM.escapeHtml(DB.livreurNomComplet(l)) + '"><div class="flex gap-10" style="align-items:center;"><span class="avatar">' + initials + '</span><strong>' + LM.escapeHtml(DB.livreurNomComplet(l)) + '</strong></div></td>' +
          dates.map(function (d) { return planningCellHtml(l, d); }).join("") +
        '</tr>';
      }).join("");

      tbody.querySelectorAll("[data-cell]").forEach(function (td) {
        td.addEventListener("click", function () {
          var parts = td.getAttribute("data-cell").split("|");
          openDayForm(DB.get("livreurs", parts[0]), parts[1]);
        });
      });

      tbody.querySelectorAll("[data-livreur]").forEach(function (td) {
        td.addEventListener("click", function () {
          var l = DB.get("livreurs", td.getAttribute("data-livreur"));
          if (l) openLivreurSummaryModal(l);
        });
      });
    }

    function planningCellHtml(l, dateIso) {
      // Avant la date d'embauche du livreur : case grisée, non cliquable (pas de data-cell).
      if (!DB.livreurEmbaucheLe(l, dateIso)) {
        return '<td class="planning-cell planning-cell-prehire" title="' + LM.escapeHtml("Pas encore embauché(e) — embauche le " + DB.fmtDate(l.dateEmbauche)) + '"><div class="planning-cell-inner">—</div></td>';
      }
      var entry = DB.planningEntreeFor(l.id, dateIso);
      var type = entry ? entry.type : null;
      var def = type ? dayTypeDef(type) : null;
      var isDemande = !!(entry && entry.fromDemande);
      var cls, styleAttr = "", inner;
      if (!entry) {
        cls = "planning-cell-empty";
        inner = "+";
      } else if (type === "travail" || type === "repos") {
        // Types fixes : classe CSS dédiée (comme avant), pas de couleur personnalisable.
        cls = FIXED_TYPES[type].cls + (isDemande ? " pln-demande-marker" : "");
        inner = type === "travail" ?
          (def.short + '<span class="planning-cell-hours">' + LM.escapeHtml(entry.heureDebut || "") + '–' + LM.escapeHtml(entry.heureFin || "") + '</span>') :
          def.short;
      } else {
        // Type d'absence personnalisable (couleur définie dans Annexes) : le libellé réel choisi
        // s'affiche toujours (CP, RTT, Maladie...), qu'il vienne d'une saisie manuelle ou d'une
        // demande d'absence — une case issue d'une demande se distingue par une bordure
        // pointillée reprenant la même couleur (pln-demande-marker), plutôt qu'un texte générique.
        cls = isDemande ? "pln-demande-marker" : "";
        styleAttr = ' style="background:' + colorTint(def.color, 0.16) + ';color:' + LM.escapeHtml(def.color) + ';"';
        inner = def.label;
      }
      var titleParts = [];
      if (entry && entry.commentaire) titleParts.push(entry.commentaire);
      if (isDemande) titleParts.push("Issu d'une demande d'absence");
      var title = titleParts.length ? ' title="' + LM.escapeHtml(titleParts.join(" — ")) + '"' : "";
      return '<td class="planning-cell ' + cls + '" data-cell="' + l.id + '|' + dateIso + '"' + title + '><div class="planning-cell-inner"' + styleAttr + '>' + inner + '</div></td>';
    }

    // ------------------------------------------------------------------
    // Récapitulatif d'effectif par jour (ligne sous l'en-tête) : nombre de livreurs présents
    // (travail) mis en avant, puis répartition colorée repos / types d'absence (couleur définie
    // dans Annexes, même pour une case issue d'une demande — voir planningCellHtml), pour voir
    // d'un coup d'œil qui est présent sans avoir à compter les cases.
    function daySummaryHtml(dateIso) {
      var travail = 0, repos = 0;
      var others = {};
      livreurs.forEach(function (l) {
        if (!DB.livreurEmbaucheLe(l, dateIso)) return;
        var e = DB.planningEntreeFor(l.id, dateIso);
        if (!e) return;
        if (e.type === "travail") travail++;
        else if (e.type === "repos") repos++;
        else others[e.type] = (others[e.type] || 0) + 1;
      });

      var pillsHtml = "";
      if (repos > 0) pillsHtml += psumPill("repos", repos, FIXED_TYPES.repos.label, null);
      // Ordre d'affichage : celui de la liste de référence (Annexes), puis d'éventuels types
      // supprimés depuis (données existantes conservées, en gris).
      var seen = {};
      absenceTypes().forEach(function (it) {
        if (others[it.key]) { pillsHtml += psumPill(it.key, others[it.key], it.label, it.color); seen[it.key] = true; }
      });
      Object.keys(others).forEach(function (k) {
        if (!seen[k]) pillsHtml += psumPill(k, others[k], dayTypeDef(k).label, FALLBACK_COLOR);
      });

      var tooltipParts = [];
      tooltipParts.push(travail + " " + FIXED_TYPES.travail.label);
      if (repos) tooltipParts.push(repos + " " + FIXED_TYPES.repos.label);
      absenceTypes().forEach(function (it) { if (others[it.key]) tooltipParts.push(others[it.key] + " " + it.label); });
      Object.keys(others).forEach(function (k) { if (!seen[k]) tooltipParts.push(others[k] + " " + dayTypeDef(k).label); });

      return '<th class="planning-summary-cell' + (dateIso === todayIso ? " pln-today" : "") + '" title="' + LM.escapeHtml(tooltipParts.join(" · ")) + '">' +
        '<div class="psum-present' + (travail > 0 ? " psum-present-active" : "") + '">' + travail + '<span class="psum-present-label">présent' + (travail > 1 ? "s" : "") + '</span></div>' +
        (pillsHtml ? '<div class="psum-pills">' + pillsHtml + '</div>' : "") +
      '</th>';
    }
    function psumPill(key, count, label, color) {
      // "repos" garde sa classe CSS fixe ; tout type d'absence est coloré en style inline à
      // partir de sa couleur (personnalisable depuis Annexes).
      var cls = key === "repos" ? "psum-pill psum-repos" : "psum-pill";
      var styleAttr = color ? ' style="background:' + colorTint(color, 0.16) + ';color:' + LM.escapeHtml(color) + ';"' : "";
      return '<span class="' + cls + '"' + styleAttr + ' title="' + LM.escapeHtml(count + " " + label) + '">' + count + '</span>';
    }

    function openDayForm(livreur, dateIso) {
      var existing = DB.planningEntreeFor(livreur.id, dateIso);
      var reglages = DB.getPlanningReglages();
      var type = existing ? existing.type : "travail";
      var heureDebut = existing ? (existing.heureDebut || reglages.heureDebut) : reglages.heureDebut;
      var heureFin = existing ? (existing.heureFin || reglages.heureFin) : reglages.heureFin;
      var pauseDuree = existing && existing.pauseDuree !== undefined ? existing.pauseDuree : (reglages.pauseActive ? reglages.pauseDuree : 0);
      var commentaire = existing ? (existing.commentaire || "") : "";
      // Jours sur lesquels appliquer la saisie : la case cliquée par défaut, avec la possibilité
      // d'en ajouter d'autres (jour par jour ou par période) pour dupliquer la même journée-type
      // sur plusieurs jours en une seule fois.
      var jours = [dateIso];

      LM.openModal({
        title: LM.escapeHtml(DB.livreurNomComplet(livreur)) + " — " + DB.fmtDate(dateIso),
        wide: true,
        bodyHtml:
          '<form id="dayForm">' +
            '<div class="field"><label>Type de journée</label><select name="type" id="dayType">' +
              allTypeKeys().map(function (k) { return '<option value="' + k + '"' + (k === type ? " selected" : "") + '>' + LM.escapeHtml(dayTypeDef(k).label) + '</option>'; }).join("") +
            '</select></div>' +
            '<div id="travailFields" class="form-row"' + (type !== "travail" ? ' style="display:none;"' : '') + '>' +
              '<div class="field"><label>Heure de début</label><input type="time" name="heureDebut" value="' + LM.escapeHtml(heureDebut) + '" /></div>' +
              '<div class="field"><label>Heure de fin</label><input type="time" name="heureFin" value="' + LM.escapeHtml(heureFin) + '" /></div>' +
              '<div class="field"><label>Pause (min)</label><input type="number" name="pauseDuree" min="0" step="5" value="' + pauseDuree + '" /></div>' +
            '</div>' +
            '<div class="field"><label>Commentaire</label><input type="text" name="commentaire" value="' + LM.escapeHtml(commentaire) + '" placeholder="Optionnel" /></div>' +
            '<div class="field">' +
              '<label>Dupliquer sur d\'autres jours</label>' +
              '<p class="text-sm text-faint" style="margin-top:0;">La journée-type ci-dessus sera appliquée à tous les jours sélectionnés ci-dessous.</p>' +
              '<div class="date-picker-panel">' +
                '<div class="form-row" style="align-items:flex-end;margin-bottom:10px;">' +
                  '<div class="field mb-0"><label>Ajouter un jour</label><input type="date" id="dayDateSingle" /></div>' +
                  '<div class="field mb-0"><button type="button" class="btn btn-secondary btn-sm" id="btnAddDayDate">' + LM.icon("plus") + ' Ajouter</button></div>' +
                '</div>' +
                '<div class="form-row" style="align-items:flex-end;margin-bottom:10px;">' +
                  '<div class="field mb-0"><label>Du</label><input type="date" id="dayRangeStart" /></div>' +
                  '<div class="field mb-0"><label>Au</label><input type="date" id="dayRangeEnd" /></div>' +
                  '<div class="field mb-0"><button type="button" class="btn btn-secondary btn-sm" id="btnAddDayRange">' + LM.icon("plus") + ' Ajouter la période</button></div>' +
                '</div>' +
                '<div class="date-chip-list" id="dayChips"></div>' +
              '</div>' +
            '</div>' +
          '</form>',
        footerHtml:
          '<button class="btn btn-secondary" id="cancelBtn">Annuler</button>' +
          (existing ? '<button class="btn btn-danger" id="clearBtn">Effacer ce jour</button>' : '') +
          '<button class="btn btn-primary" id="saveBtn">Enregistrer</button>',
        onMount: function (modal) {
          renderDayChips();

          modal.querySelector("#dayType").addEventListener("change", function (e) {
            modal.querySelector("#travailFields").style.display = e.target.value === "travail" ? "flex" : "none";
          });
          modal.querySelector("#cancelBtn").addEventListener("click", LM.closeModal);

          modal.querySelector("#btnAddDayDate").addEventListener("click", function () {
            var input = modal.querySelector("#dayDateSingle");
            var v = input.value;
            if (!v) return;
            if (jours.indexOf(v) === -1) { jours.push(v); jours.sort(); renderDayChips(); }
            input.value = "";
          });
          modal.querySelector("#btnAddDayRange").addEventListener("click", function () {
            var start = modal.querySelector("#dayRangeStart").value;
            var end = modal.querySelector("#dayRangeEnd").value;
            if (!start || !end || start > end) { LM.toast("Période invalide.", "danger"); return; }
            var cur = start, added = 0;
            while (cur <= end) {
              if (jours.indexOf(cur) === -1) { jours.push(cur); added++; }
              cur = addDaysIso(cur, 1);
            }
            jours.sort();
            renderDayChips();
            if (added) LM.toast(added + " jour(s) ajouté(s).", "success");
          });

          if (existing) {
            modal.querySelector("#clearBtn").addEventListener("click", function () {
              DB.removePlanningEntree(livreur.id, dateIso);
              LM.toast("Case effacée.", "success");
              LM.closeModal();
              renderBody();
              renderSummaryRow();
            });
          }
          modal.querySelector("#saveBtn").addEventListener("click", function () {
            if (!jours.length) { LM.toast("Sélectionnez au moins un jour.", "danger"); return; }
            var fd = new FormData(modal.querySelector("#dayForm"));
            var t = fd.get("type");
            // Une saisie manuelle prévaut toujours sur une éventuelle demande d'absence associée
            // au(x) jour(s) : on efface l'indicateur "fromDemande" pour repasser la case en
            // saisie normale (bordure pointillée retirée, la case suit alors uniquement le type
            // choisi ci-dessus).
            var patch = { type: t, commentaire: (fd.get("commentaire") || "").toString().trim(), fromDemande: false };
            if (t === "travail") {
              patch.heureDebut = fd.get("heureDebut") || reglages.heureDebut;
              patch.heureFin = fd.get("heureFin") || reglages.heureFin;
              patch.pauseDuree = Number(fd.get("pauseDuree")) || 0;
            } else {
              patch.heureDebut = ""; patch.heureFin = ""; patch.pauseDuree = 0;
            }
            // Jours antérieurs à l'embauche (dupliqués par date ou par période) : ignorés.
            var joursValides = jours.filter(function (j) { return DB.livreurEmbaucheLe(livreur, j); });
            var avantEmbauche = jours.length - joursValides.length;
            if (!joursValides.length) { LM.toast("Tous les jours sélectionnés sont antérieurs à la date d'embauche (" + DB.fmtDate(livreur.dateEmbauche) + ").", "danger"); return; }
            var toUpsert = joursValides.map(function (j) { return { livreurId: livreur.id, date: j, patch: patch }; });
            var result = DB.bulkUpsertPlanningEntree(toUpsert);
            if (!result.saved) {
              LM.toast("Enregistrement impossible (espace de stockage local insuffisant).", "danger");
              return;
            }
            LM.toast((joursValides.length > 1 ? joursValides.length + " jours enregistrés." : "Journée enregistrée.") +
              (avantEmbauche ? " " + avantEmbauche + " jour(s) antérieur(s) à l'embauche ignoré(s)." : ""), "success");
            LM.closeModal();
            // On rafraîchit systématiquement la grille ET la ligne "Effectif du jour" : même un
            // simple changement d'horaires (sans changer le type) peut faire évoluer d'autres
            // éléments dérivés (heures supplémentaires...), et le nombre de présents doit de
            // toute façon toujours refléter l'état réel de la grille juste en dessous.
            renderBody();
            renderSummaryRow();
          });

          function renderDayChips() {
            var wrap = modal.querySelector("#dayChips");
            wrap.innerHTML = jours.length ? jours.map(function (j) {
              return '<span class="date-chip">' + DB.fmtDate(j) + (j === dateIso ? '' : '<button type="button" data-rmjour="' + j + '">' + LM.icon("close") + '</button>') + '</span>';
            }).join("") : '<span class="text-faint text-sm">Aucun jour sélectionné.</span>';
            wrap.querySelectorAll("[data-rmjour]").forEach(function (btn) {
              btn.addEventListener("click", function () {
                var v = btn.getAttribute("data-rmjour");
                jours = jours.filter(function (j) { return j !== v; });
                renderDayChips();
              });
            });
          }
        }
      });
    }

    // ------------------------------------------------------------------
    // Génération automatique : pour chaque livreur sélectionné et chaque jour de la période,
    // applique la demande d'absence en cours si elle existe, sinon "Repos" le dimanche (si non
    // travaillé) ou "Travail" aux horaires par défaut.
    // ------------------------------------------------------------------
    function openProposerPlanningModal() {
      var reglages = DB.getPlanningReglages();

      if (!livreurs.length) { LM.toast("Aucun livreur disponible pour générer un planning.", "danger"); return; }

      LM.openModal({
        title: "Proposer un planning automatique",
        wide: true,
        bodyHtml:
          '<p class="text-sm text-faint" style="margin-top:0;">Le planning est généré à partir des demandes d\'absence enregistrées (onglet Historique des demandes) et des paramètres par défaut (onglet Paramètres planning). Les jours sans demande sont marqués « Travail », ou « Repos » le dimanche si le travail dominical est désactivé.</p>' +
          '<div class="form-row">' +
            '<div class="field"><label>Du</label><input type="date" id="propDateStart" value="' + dates[0] + '" /></div>' +
            '<div class="field"><label>Au</label><input type="date" id="propDateEnd" value="' + dates[6] + '" /></div>' +
          '</div>' +
          '<div class="field"><label>Livreurs concernés</label>' +
            '<div class="planning-livreur-chip-list">' +
              livreurs.map(function (l) {
                return '<label class="planning-livreur-check"><input type="checkbox" data-proplivreur="' + l.id + '" checked /> ' + LM.escapeHtml(DB.livreurNomComplet(l)) + '</label>';
              }).join("") +
            '</div>' +
          '</div>' +
          '<div class="checkbox-row" style="margin-top:6px;">' +
            '<input type="checkbox" id="propEcraser" />' +
            '<label for="propEcraser" style="margin:0;">Remplacer les jours déjà planifiés (sinon, seules les cases vides sont complétées)</label>' +
          '</div>',
        footerHtml:
          '<button class="btn btn-secondary" id="cancelBtn">Annuler</button>' +
          '<button class="btn btn-wand" id="genBtn">' + LM.icon("wand") + ' Générer le planning</button>',
        onMount: function (modal) {
          modal.querySelector("#cancelBtn").addEventListener("click", LM.closeModal);
          modal.querySelector("#genBtn").addEventListener("click", function () {
            var start = modal.querySelector("#propDateStart").value;
            var end = modal.querySelector("#propDateEnd").value;
            if (!start || !end || start > end) { LM.toast("Période invalide.", "danger"); return; }
            var selectedIds = Array.prototype.slice.call(modal.querySelectorAll("[data-proplivreur]"))
              .filter(function (cb) { return cb.checked; })
              .map(function (cb) { return cb.getAttribute("data-proplivreur"); });
            if (!selectedIds.length) { LM.toast("Sélectionnez au moins un livreur.", "danger"); return; }
            var ecraser = modal.querySelector("#propEcraser").checked;

            var jours = [];
            var d = start;
            while (d <= end) { jours.push(d); d = addDaysIso(d, 1); }

            // Au-delà de deux mois, on demande confirmation avant de générer : la période est
            // probablement plus large que voulu (le champ "Au" est resté sur une vieille valeur, etc.).
            if (jours.length > 62) {
              LM.confirmDialog(
                "La période sélectionnée couvre " + jours.length + " jours pour " + selectedIds.length + " livreur(s), soit " +
                (jours.length * selectedIds.length) + " case(s) à générer. Continuer ?",
                doGenerate
              );
            } else {
              doGenerate();
            }

            function doGenerate() {
              // On construit la liste des cases à écrire, puis on les enregistre en une seule
              // fois (DB.bulkUpsertPlanningEntree) plutôt qu'une sauvegarde par case : avec des
              // sauvegardes individuelles, générer plusieurs centaines de cases ré-écrit
              // l'intégralité des données de l'application à chaque case et fige le navigateur.
              //
              // On pré-indexe aussi les cases déjà planifiées et les demandes d'absence (une
              // seule fois, en O(n)) au lieu d'appeler DB.planningEntreeFor / DB.demandeAbsencePour
              // (recherche linéaire) pour chaque case à générer : avec des tableaux qui grossissent
              // mois après mois, ces recherches répétées suffisaient à elles seules à geler le
              // navigateur sur une génération portant sur plusieurs mois et plusieurs livreurs,
              // même une fois la sauvegarde elle-même regroupée en un seul appel.
              var existingIndex = {};
              DB.list("planningEntrees").forEach(function (e) { existingIndex[e.livreurId + "|" + e.date] = e; });

              var demandesIndex = {};
              DB.list("demandesAbsence").forEach(function (dem) {
                if (!Array.isArray(dem.jours)) return;
                dem.jours.forEach(function (j) {
                  var key = dem.livreurId + "|" + j;
                  var cur = demandesIndex[key];
                  if (!cur || (dem.dateDemande || "") > (cur.dateDemande || "")) demandesIndex[key] = dem;
                });
              });

              var toUpsert = [];
              var skipped = 0;
              var avantEmbauche = 0;
              selectedIds.forEach(function (livId) {
                var livGen = DB.get("livreurs", livId);
                jours.forEach(function (dateIso) {
                  // Pas de génération avant la date d'embauche du livreur.
                  if (!DB.livreurEmbaucheLe(livGen, dateIso)) { avantEmbauche++; return; }
                  var key = livId + "|" + dateIso;
                  var existing = existingIndex[key];
                  if (existing && !ecraser) { skipped++; return; }
                  var demande = demandesIndex[key];
                  var patch;
                  if (demande) {
                    // Case issue d'une demande d'absence : marquée fromDemande pour un affichage
                    // dédié dans la grille ("Repos - demande"), quel que soit le type réel de la
                    // demande (le motif reste conservé en commentaire).
                    patch = { type: demande.type, heureDebut: "", heureFin: "", pauseDuree: 0, commentaire: demande.motif || "", fromDemande: true };
                  } else {
                    var jsDay = new Date(dateIso + "T00:00:00").getDay();
                    if (jsDay === 0 && !reglages.dimancheTravaille) {
                      patch = { type: "repos", heureDebut: "", heureFin: "", pauseDuree: 0, commentaire: "", fromDemande: false };
                    } else {
                      patch = {
                        type: "travail",
                        heureDebut: reglages.heureDebut, heureFin: reglages.heureFin,
                        pauseDuree: reglages.pauseActive ? reglages.pauseDuree : 0,
                        commentaire: "",
                        fromDemande: false
                      };
                    }
                  }
                  toUpsert.push({ livreurId: livId, date: dateIso, patch: patch });
                });
              });

              var result = DB.bulkUpsertPlanningEntree(toUpsert);

              if (!result.saved) {
                // La génération a bien été calculée mais n'a pas pu être enregistrée (le plus
                // souvent : quota de stockage local dépassé). On prévient clairement plutôt que
                // de laisser croire que tout s'est bien passé.
                LM.toast("La génération a échoué à l'enregistrement (espace de stockage local insuffisant). Réduisez la période ou le nombre de livreurs, ou libérez de l'espace, puis réessayez.", "danger");
                return;
              }

              var msg = toUpsert.length + " jour(s) généré(s) pour " + selectedIds.length + " livreur(s)" +
                (skipped ? " (" + skipped + " case(s) déjà planifiée(s) conservée(s))" : "") + "." +
                (avantEmbauche ? " " + avantEmbauche + " case(s) antérieure(s) à l'embauche ignorée(s)." : "");
              LM.toast(msg, "success");
              LM.closeModal();
              renderPlanningTab(panel);
            }
          });
        }
      });
    }

    // ------------------------------------------------------------------
    // Export PDF du planning : période + livreurs au choix (par défaut tous), un rapport
    // imprimable avec une section par livreur — utile notamment lorsqu'un livreur demande une
    // copie de son propre planning (chaque section démarre sur une nouvelle page à l'impression).
    // ------------------------------------------------------------------
    function openExportPlanningPdfModal() {
      if (!livreurs.length) { LM.toast("Aucun livreur disponible pour l'export.", "danger"); return; }

      LM.openModal({
        title: "Exporter le planning en PDF",
        wide: true,
        bodyHtml:
          '<p class="text-sm text-faint" style="margin-top:0;">Générez un planning imprimable pour un ou plusieurs livreurs, sur la période de votre choix — pratique par exemple lorsqu\'un livreur demande une copie de son planning.</p>' +
          '<div class="form-row">' +
            '<div class="field"><label>Du</label><input type="date" id="pplDateStart" value="' + dates[0] + '" /></div>' +
            '<div class="field"><label>Au</label><input type="date" id="pplDateEnd" value="' + dates[6] + '" /></div>' +
          '</div>' +
          '<div class="field">' +
            '<label>Livreurs concernés</label>' +
            '<div class="flex gap-10" style="margin-bottom:8px;">' +
              '<button type="button" class="btn btn-ghost btn-sm" id="pplAll">Tout cocher</button>' +
              '<button type="button" class="btn btn-ghost btn-sm" id="pplNone">Tout décocher</button>' +
            '</div>' +
            '<div class="planning-livreur-chip-list">' +
              livreurs.map(function (l) {
                return '<label class="planning-livreur-check"><input type="checkbox" data-ppllivreur="' + l.id + '" checked /> ' + LM.escapeHtml(DB.livreurNomComplet(l)) + '</label>';
              }).join("") +
            '</div>' +
          '</div>',
        footerHtml:
          '<button class="btn btn-secondary" id="cancelBtn">Annuler</button>' +
          '<button class="btn btn-pdf" id="pplGo">' + LM.icon("file") + ' Générer le PDF</button>',
        onMount: function (modal) {
          modal.querySelector("#cancelBtn").addEventListener("click", LM.closeModal);
          modal.querySelector("#pplAll").addEventListener("click", function () {
            modal.querySelectorAll("[data-ppllivreur]").forEach(function (cb) { cb.checked = true; });
          });
          modal.querySelector("#pplNone").addEventListener("click", function () {
            modal.querySelectorAll("[data-ppllivreur]").forEach(function (cb) { cb.checked = false; });
          });
          modal.querySelector("#pplGo").addEventListener("click", function () {
            var start = modal.querySelector("#pplDateStart").value;
            var end = modal.querySelector("#pplDateEnd").value;
            if (!start || !end || start > end) { LM.toast("Période invalide.", "danger"); return; }
            var selectedIds = Array.prototype.slice.call(modal.querySelectorAll("[data-ppllivreur]"))
              .filter(function (cb) { return cb.checked; })
              .map(function (cb) { return cb.getAttribute("data-ppllivreur"); });
            if (!selectedIds.length) { LM.toast("Sélectionnez au moins un livreur.", "danger"); return; }
            var selectedLivreurs = selectedIds.map(function (id) { return DB.get("livreurs", id); }).filter(Boolean)
              .sort(function (a, b) { return DB.livreurNomComplet(a).localeCompare(DB.livreurNomComplet(b)); });
            LM.closeModal();
            exportPlanningPdf(selectedLivreurs, start, end);
          });
        }
      });
    }

    function exportPlanningPdf(selectedLivreurs, start, end) {
      var jours = [];
      var d = start;
      while (d <= end) { jours.push(d); d = addDaysIso(d, 1); }

      var periodeLabel = "Période : " + DB.fmtDate(start) + " → " + DB.fmtDate(end) + " (" + jours.length + " jour(s))";
      var subtitle = LM.escapeHtml(periodeLabel + "\n" + selectedLivreurs.length + " livreur(s) sélectionné(s)");

      var totalCells = selectedLivreurs.length * jours.length;
      var filledCells = 0, travailCells = 0;
      totalCells = 0;
      selectedLivreurs.forEach(function (l) {
        jours.forEach(function (dt) {
          if (!DB.livreurEmbaucheLe(l, dt)) return; // avant l'embauche : hors du taux de remplissage
          totalCells++;
          var e = DB.planningEntreeFor(l.id, dt);
          if (e) { filledCells++; if (e.type === "travail") travailCells++; }
        });
      });
      var couverture = totalCells ? Math.round((filledCells / totalCells) * 100) : 0;

      var kpisHtml =
        '<div class="pr-kpis">' +
          '<div class="pr-kpi"><div class="pr-kpi-label">Livreurs</div><div class="pr-kpi-value">' + selectedLivreurs.length + '</div></div>' +
          '<div class="pr-kpi"><div class="pr-kpi-label">Jours couverts</div><div class="pr-kpi-value">' + jours.length + '</div></div>' +
          '<div class="pr-kpi"><div class="pr-kpi-label">Jours de travail (total)</div><div class="pr-kpi-value">' + travailCells + '</div></div>' +
          '<div class="pr-kpi"><div class="pr-kpi-label">Taux de remplissage</div><div class="pr-kpi-value">' + couverture + '%</div></div>' +
        '</div>';

      function pdfTypeBadge(type) {
        if (!type) return '<span class="pr-badge pr-badge-neutral">Non planifié</span>';
        var def = dayTypeDef(type);
        if (FIXED_TYPES[type]) {
          var cls = type === "travail" ? "pr-badge-success" : "pr-badge-neutral";
          return '<span class="pr-badge ' + cls + '">' + LM.escapeHtml(def.label) + '</span>';
        }
        return '<span class="pr-badge" style="background:' + colorTint(def.color, 0.16) + ';color:' + LM.escapeHtml(def.color) + ';">' + LM.escapeHtml(def.label) + '</span>';
      }

      var sections = selectedLivreurs.map(function (l, idx) {
        var nbTravail = 0, nbRepos = 0, nbAbsence = 0;
        var rows = jours.map(function (dt) {
          if (!DB.livreurEmbaucheLe(l, dt)) {
            var jsDayPre = new Date(dt + "T00:00:00").getDay();
            return '<tr><td>' + JOURS_SEMAINE[jsDayPre === 0 ? 6 : jsDayPre - 1] + ' ' + DB.fmtDate(dt) + '</td>' +
              '<td><span class="pr-badge pr-badge-neutral">Pas encore embauché(e)</span></td><td>—</td><td>Embauche le ' + DB.fmtDate(l.dateEmbauche) + '</td></tr>';
          }
          var e = DB.planningEntreeFor(l.id, dt);
          if (e) {
            if (e.type === "travail") nbTravail++;
            else if (e.type === "repos") nbRepos++;
            else nbAbsence++;
          }
          var jsDay = new Date(dt + "T00:00:00").getDay();
          var jourNom = JOURS_SEMAINE[jsDay === 0 ? 6 : jsDay - 1];
          var horaires = e && e.type === "travail" ? (LM.escapeHtml(e.heureDebut || "") + '–' + LM.escapeHtml(e.heureFin || "")) : "—";
          return '<tr>' +
            '<td>' + jourNom + ' ' + DB.fmtDate(dt) + '</td>' +
            '<td>' + pdfTypeBadge(e ? e.type : null) + (e && e.fromDemande ? ' <span class="pr-badge pr-badge-neutral">Sur demande</span>' : '') + '</td>' +
            '<td>' + horaires + '</td>' +
            '<td>' + (e && e.commentaire ? LM.escapeHtml(e.commentaire) : "—") + '</td>' +
          '</tr>';
        }).join("");

        return '<div' + (idx > 0 ? ' class="pr-pagebreak"' : '') + '>' +
          '<div class="pr-section-title">' + LM.escapeHtml(DB.livreurNomComplet(l)) + '</div>' +
          '<p style="font-size:11.5px;color:#6b7280;margin:0 0 10px;">' + nbTravail + ' jour(s) de travail · ' + nbRepos + ' jour(s) de repos · ' + nbAbsence + ' jour(s) d\'absence/congé</p>' +
          '<table class="pr-table"><thead><tr><th>Jour</th><th>Type</th><th>Horaires</th><th>Commentaire</th></tr></thead><tbody>' + rows + '</tbody></table>' +
        '</div>';
      }).join("");

      var body = kpisHtml + sections;
      LM.printReport("Planning des livreurs", body, { subtitle: subtitle });
    }
  }

  // ------------------------------------------------------------------
  // Onglet Historique des demandes
  // ------------------------------------------------------------------
  function renderHistoriqueTab(panel) {
    var livreurs = DB.list("livreurs");

    panel.innerHTML =
      '<div class="card-header" style="margin-top:6px;"><div><h3>Historique des demandes d\'absence</h3><p class="text-sm">Congés, RTT, arrêts maladie... déclarés par les livreurs. Ces demandes alimentent la génération automatique du planning.</p></div>' +
        '<button class="btn btn-primary" id="btnNewDemande">' + LM.icon("plus") + ' Nouvelle demande</button>' +
      '</div>' +
      '<div class="form-row" style="margin-bottom:10px;">' +
        '<div class="field mb-0"><label>Recherche</label><input type="search" id="hdq" placeholder="Livreur, motif…" value="' + LM.escapeHtml(histFilters.q) + '" /></div>' +
        '<div class="field mb-0"><label>Type</label><select id="hdType"><option value="">Tous types</option>' +
          motifTypeKeys().map(function (k) { return '<option value="' + k + '"' + (k === histFilters.type ? " selected" : "") + '>' + LM.escapeHtml(dayTypeDef(k).label) + '</option>'; }).join("") +
        '</select></div>' +
      '</div>' +
      '<p class="text-sm" id="demSummary"></p>' +
      '<div class="table-wrap"><table><thead><tr>' +
        '<th>Livreur</th><th>Date de la demande</th><th>Type</th><th>Jours concernés</th><th>Motif</th><th></th>' +
      '</tr></thead><tbody id="demBody"></tbody></table></div>';

    document.getElementById("btnNewDemande").addEventListener("click", function () { openDemandeForm(null); });
    document.getElementById("hdq").addEventListener("input", function (e) { histFilters.q = e.target.value; renderRows(); });
    document.getElementById("hdType").addEventListener("change", function (e) { histFilters.type = e.target.value; renderRows(); });

    renderRows();

    function renderRows() {
      var q = DB.normalizeStr(histFilters.q);
      var rows = DB.list("demandesAbsence").filter(function (d) {
        if (histFilters.type && d.type !== histFilters.type) return false;
        if (q) {
          var l = DB.get("livreurs", d.livreurId);
          var hay = DB.normalizeStr((l ? DB.livreurNomComplet(l) : "") + " " + (d.motif || ""));
          if (hay.indexOf(q) === -1) return false;
        }
        return true;
      }).sort(function (a, b) { return (b.dateDemande || "").localeCompare(a.dateDemande || ""); });

      var totalJours = rows.reduce(function (a, d) { return a + ((d.jours || []).length); }, 0);
      document.getElementById("demSummary").textContent = rows.length + " demande(s) — " + totalJours + " jour(s) au total";

      var tbody = document.getElementById("demBody");
      if (!rows.length) { tbody.innerHTML = '<tr class="empty-row"><td colspan="6">Aucune demande enregistrée.</td></tr>'; return; }

      tbody.innerHTML = rows.map(function (d) {
        var l = DB.get("livreurs", d.livreurId);
        return '<tr>' +
          '<td><strong>' + LM.escapeHtml(l ? DB.livreurNomComplet(l) : "Livreur supprimé") + '</strong></td>' +
          '<td class="text-sm">' + DB.fmtDate(d.dateDemande) + '</td>' +
          '<td>' + typeBadgeHtml(d.type) + '</td>' +
          '<td class="text-sm">' + formatJoursCompact(d.jours) + '</td>' +
          '<td class="text-sm">' + (d.motif ? LM.escapeHtml(d.motif) : '<span class="text-faint">—</span>') + '</td>' +
          '<td class="actions">' +
            '<button class="btn btn-ghost btn-sm btn-icon" data-edit="' + d.id + '" title="Modifier">' + LM.icon("edit") + '</button>' +
            '<button class="btn btn-ghost btn-sm btn-icon" data-del="' + d.id + '" title="Supprimer">' + LM.icon("trash") + '</button>' +
          '</td>' +
        '</tr>';
      }).join("");

      tbody.querySelectorAll("[data-edit]").forEach(function (btn) {
        btn.addEventListener("click", function () { openDemandeForm(DB.get("demandesAbsence", btn.getAttribute("data-edit"))); });
      });
      tbody.querySelectorAll("[data-del]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var id = btn.getAttribute("data-del");
          var dDel = DB.get("demandesAbsence", id);
          var lDel = dDel ? DB.get("livreurs", dDel.livreurId) : null;
          LM.confirmDialog("Supprimer cette demande ? Les jours déjà générés dans le planning ne seront pas modifiés rétroactivement.", function () {
            DB.remove("demandesAbsence", id);
            DB.logHistorique("Planning", "suppression", "Suppression demande d'absence : " + (lDel ? DB.livreurNomComplet(lDel) : "livreur inconnu"));
            LM.toast("Demande supprimée.", "success");
            renderRows();
          });
        });
      });
    }

  }

  // ------------------------------------------------------------------
  // Formulaire de demande d'absence (créer/modifier). Fonction de niveau module afin d'être
  // réutilisable depuis l'onglet Historique et depuis la fenêtre récapitulative d'un livreur
  // (onglet Planning, clic sur le nom d'un livreur). `presetLivreurId` pré-sélectionne le
  // livreur lorsqu'on ouvre le formulaire depuis sa fiche.
  // ------------------------------------------------------------------
  function openDemandeForm(existing, presetLivreurId) {
    var livreurs = DB.list("livreurs");
    var isEdit = !!existing;
    var defaultTypeKey = motifTypeKeys()[0] || "";
    var d = existing || { livreurId: presetLivreurId || "", dateDemande: DB.todayISO(), type: defaultTypeKey, jours: [], motif: "" };
    var jours = (d.jours || []).slice().sort();

    LM.openModal({
      title: isEdit ? "Modifier la demande" : "Nouvelle demande d'absence",
      wide: true,
      bodyHtml:
        '<form id="demForm">' +
          '<div class="form-row">' +
            '<div class="field"><label>Livreur *</label><select name="livreurId" required>' +
              '<option value="">Sélectionner…</option>' +
              livreurs.map(function (l) { return '<option value="' + l.id + '"' + (l.id === d.livreurId ? " selected" : "") + '>' + LM.escapeHtml(DB.livreurNomComplet(l)) + '</option>'; }).join("") +
            '</select></div>' +
              '<div class="field"><label>Date de la demande</label><input type="date" name="dateDemande" value="' + d.dateDemande + '" /></div>' +
            '</div>' +
            '<div class="field"><label>Type d\'absence</label><select name="type">' +
              (motifTypeKeys().length ? motifTypeKeys().map(function (k) { return '<option value="' + k + '"' + (k === d.type ? " selected" : "") + '>' + LM.escapeHtml(dayTypeDef(k).label) + '</option>'; }).join("") : '<option value="">Aucun type disponible — ajoutez-en depuis Annexes</option>') +
            '</select></div>' +
            '<div class="field">' +
              '<label>Jours concernés</label>' +
              '<div class="date-picker-panel">' +
                '<div class="form-row" style="align-items:flex-end;margin-bottom:10px;">' +
                  '<div class="field mb-0"><label>Ajouter un jour</label><input type="date" id="demDateSingle" /></div>' +
                  '<div class="field mb-0"><button type="button" class="btn btn-secondary btn-sm" id="btnAddDemDate">' + LM.icon("plus") + ' Ajouter</button></div>' +
                '</div>' +
                '<div class="form-row" style="align-items:flex-end;margin-bottom:10px;">' +
                  '<div class="field mb-0"><label>Du</label><input type="date" id="demRangeStart" /></div>' +
                  '<div class="field mb-0"><label>Au</label><input type="date" id="demRangeEnd" /></div>' +
                  '<div class="field mb-0"><button type="button" class="btn btn-secondary btn-sm" id="btnAddDemRange">' + LM.icon("plus") + ' Ajouter la période</button></div>' +
                '</div>' +
                '<div class="date-chip-list" id="demChips"></div>' +
              '</div>' +
            '</div>' +
            '<div class="field"><label>Motif</label><textarea name="motif" placeholder="ex : Congés d\'été, RDV médical…">' + LM.escapeHtml(d.motif || "") + '</textarea></div>' +
          '</form>',
        footerHtml:
          '<button class="btn btn-secondary" id="cancelBtn">Annuler</button>' +
          (isEdit ? '<button class="btn btn-danger" id="deleteBtn">Supprimer</button>' : '') +
          '<button class="btn btn-primary" id="saveBtn">' + (isEdit ? "Enregistrer" : "Créer la demande") + '</button>',
        onMount: function (modal) {
          renderChips();

          modal.querySelector("#btnAddDemDate").addEventListener("click", function () {
            var input = modal.querySelector("#demDateSingle");
            var v = input.value;
            if (!v) return;
            if (jours.indexOf(v) === -1) { jours.push(v); jours.sort(); renderChips(); }
            input.value = "";
          });
          modal.querySelector("#btnAddDemRange").addEventListener("click", function () {
            var start = modal.querySelector("#demRangeStart").value;
            var end = modal.querySelector("#demRangeEnd").value;
            if (!start || !end || start > end) { LM.toast("Période invalide.", "danger"); return; }
            var cur = start, added = 0;
            while (cur <= end) {
              if (jours.indexOf(cur) === -1) { jours.push(cur); added++; }
              cur = addDaysIso(cur, 1);
            }
            jours.sort();
            renderChips();
            if (added) LM.toast(added + " jour(s) ajouté(s).", "success");
          });
          modal.querySelector("#cancelBtn").addEventListener("click", LM.closeModal);
          if (isEdit) {
            modal.querySelector("#deleteBtn").addEventListener("click", function () {
              LM.confirmDialog("Supprimer définitivement cette demande ?", function () {
                DB.remove("demandesAbsence", d.id);
                var lDel2 = DB.get("livreurs", d.livreurId);
                DB.logHistorique("Planning", "suppression", "Suppression demande d'absence : " + (lDel2 ? DB.livreurNomComplet(lDel2) : "livreur inconnu"));
                LM.toast("Demande supprimée.", "success");
                LM.closeModal();
                render(document.getElementById("content"));
              });
            });
          }
          modal.querySelector("#saveBtn").addEventListener("click", function () {
            var fd = new FormData(modal.querySelector("#demForm"));
            var livreurId = fd.get("livreurId");
            if (!livreurId) { LM.toast("Sélectionnez un livreur.", "danger"); return; }
            if (!jours.length) { LM.toast("Ajoutez au moins un jour concerné.", "danger"); return; }
            var payload = {
              livreurId: livreurId,
              dateDemande: fd.get("dateDemande") || DB.todayISO(),
              type: fd.get("type"),
              jours: jours.slice(),
              motif: (fd.get("motif") || "").toString().trim()
            };
            if (isEdit) DB.update("demandesAbsence", d.id, payload);
            else DB.add("demandesAbsence", payload);
            var lLog = DB.get("livreurs", livreurId);
            DB.logHistorique("Planning", isEdit ? "modification" : "ajout", (isEdit ? "Modification" : "Ajout") + " demande d'absence : " + (lLog ? DB.livreurNomComplet(lLog) : "livreur inconnu") + " (" + dayTypeDef(payload.type).label + ", " + payload.jours.length + " jour(s))");

            // La demande met aussi immédiatement à jour les cases correspondantes du planning
            // (sans attendre un clic sur "Proposer planning") : c'est une génération rapide et
            // toujours fiable, qui ne porte que sur les jours de cette demande.
            // Les jours antérieurs à la date d'embauche du livreur ne génèrent pas de case.
            var livDem = DB.get("livreurs", payload.livreurId);
            var toUpsert = payload.jours.filter(function (j) { return DB.livreurEmbaucheLe(livDem, j); }).map(function (j) {
              return { livreurId: payload.livreurId, date: j, patch: { type: payload.type, heureDebut: "", heureFin: "", pauseDuree: 0, commentaire: payload.motif || "", fromDemande: true } };
            });
            var result = DB.bulkUpsertPlanningEntree(toUpsert);

            if (!result.saved) {
              LM.toast("La demande n'a pas pu être enregistrée (espace de stockage local insuffisant). Libérez de l'espace puis réessayez.", "danger");
              return;
            }

            LM.toast("Demande enregistrée et planning mis à jour pour " + toUpsert.length + " jour(s)." +
              (toUpsert.length < payload.jours.length ? " " + (payload.jours.length - toUpsert.length) + " jour(s) antérieur(s) à l'embauche ignoré(s) dans le planning." : ""), "success");
            LM.closeModal();
            render(document.getElementById("content"));
          });

          function renderChips() {
            var wrap = modal.querySelector("#demChips");
            wrap.innerHTML = jours.length ? jours.map(function (j) {
              return '<span class="date-chip">' + DB.fmtDate(j) + '<button type="button" data-rmjour="' + j + '">' + LM.icon("close") + '</button></span>';
            }).join("") : '<span class="text-faint text-sm">Aucun jour sélectionné.</span>';
            wrap.querySelectorAll("[data-rmjour]").forEach(function (btn) {
              btn.addEventListener("click", function () {
                var v = btn.getAttribute("data-rmjour");
                jours = jours.filter(function (j) { return j !== v; });
                renderChips();
              });
            });
          }
        }
      });
    }

  // ------------------------------------------------------------------
  // Fenêtre récapitulative d'un livreur : ouverte au clic sur son nom dans la grille du
  // Planning. Onglet "Récapitulatif" (heures/jours travaillés et heures supplémentaires sur
  // une période donnée) et onglet "Demandes faites" (historique filtré sur ce livreur).
  // ------------------------------------------------------------------
  function firstOfMonth(iso) {
    return iso.slice(0, 8) + "01";
  }

  function dureeHeures(entry) {
    if (!entry || !entry.heureDebut || !entry.heureFin) return 0;
    var toMin = function (s) {
      var p = s.split(":");
      return (Number(p[0]) || 0) * 60 + (Number(p[1]) || 0);
    };
    var mins = toMin(entry.heureFin) - toMin(entry.heureDebut);
    if (mins < 0) mins += 24 * 60;
    mins -= (entry.pauseDuree || 0);
    return Math.max(0, mins) / 60;
  }

  // Calcule, pour un livreur et une période donnée, les heures/jours travaillés, la
  // répartition par type de journée et le détail des heures supplémentaires semaine par
  // semaine (au-delà du seuil `joursAvantHeuresSup` des réglages planning).
  function computeRecap(livreurId, startIso, endIso) {
    var reglages = DB.getPlanningReglages();
    var seuil = reglages.joursAvantHeuresSup;
    if (seuil === undefined || seuil === null || isNaN(seuil)) seuil = 5;

    var livRecap = DB.get("livreurs", livreurId);
    var entries = DB.list("planningEntrees").filter(function (e) {
      return e.livreurId === livreurId && e.date >= startIso && e.date <= endIso && DB.livreurEmbaucheLe(livRecap, e.date);
    }).sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });

    var counts = {};
    allTypeKeys().forEach(function (k) { counts[k] = 0; });
    var heuresTotal = 0;
    var weeksMap = {};

    entries.forEach(function (e) {
      // Compte aussi les entrées dont le type aurait depuis été supprimé de la liste de
      // référence (Annexes) : leurs jours restent visibles dans la répartition (libellé "Type
      // supprimé" via dayTypeDef), plutôt que de disparaître silencieusement du récapitulatif.
      if (counts[e.type] === undefined) counts[e.type] = 0;
      counts[e.type]++;
      if (e.type === "travail") {
        var h = dureeHeures(e);
        heuresTotal += h;
        var wk = mondayOf(e.date);
        if (!weeksMap[wk]) weeksMap[wk] = { weekStart: wk, weekEnd: addDaysIso(wk, 6), jours: [] };
        weeksMap[wk].jours.push({ date: e.date, heures: h });
      }
    });

    var weeks = Object.keys(weeksMap).sort().map(function (wk) {
      var w = weeksMap[wk];
      w.jours.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
      var joursTravail = w.jours.length;
      var joursSup = Math.max(0, joursTravail - seuil);
      var heuresSemaine = w.jours.reduce(function (a, j) { return a + j.heures; }, 0);
      var heuresSup = 0;
      for (var i = joursTravail - joursSup; i < joursTravail; i++) heuresSup += w.jours[i].heures;
      return {
        weekStart: w.weekStart, weekEnd: w.weekEnd,
        joursTravail: joursTravail, joursSup: joursSup,
        heures: heuresSemaine, heuresSup: heuresSup
      };
    });

    var joursSupTotal = weeks.reduce(function (a, w) { return a + w.joursSup; }, 0);
    var heuresSupTotal = weeks.reduce(function (a, w) { return a + w.heuresSup; }, 0);

    return {
      seuil: seuil,
      counts: counts,
      heuresTotal: heuresTotal,
      joursSupTotal: joursSupTotal,
      heuresSupTotal: heuresSupTotal,
      weeks: weeks
    };
  }

  function openLivreurSummaryModal(livreur) {
    var todayIso = DB.todayISO();
    var recapRange = { start: firstOfMonth(todayIso), end: todayIso };

    LM.openModal({
      title: LM.escapeHtml(DB.livreurNomComplet(livreur)),
      wide: true,
      bodyHtml:
        '<div class="tabs">' +
          '<button class="tab-btn active" data-ltab="recap">Récapitulatif</button>' +
          '<button class="tab-btn" data-ltab="demandes">Demandes faites</button>' +
        '</div>' +
        '<div id="lpanelRecap" class="tab-panel active"></div>' +
        '<div id="lpanelDemandes" class="tab-panel"></div>',
      footerHtml: '<button class="btn btn-secondary" id="closeLivBtn">Fermer</button>',
      onMount: function (modal) {
        modal.querySelector("#closeLivBtn").addEventListener("click", LM.closeModal);
        modal.querySelectorAll("[data-ltab]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            modal.querySelectorAll("[data-ltab]").forEach(function (b) { b.classList.remove("active"); });
            modal.querySelectorAll(".tab-panel").forEach(function (p) { p.classList.remove("active"); });
            btn.classList.add("active");
            var key = btn.getAttribute("data-ltab");
            modal.querySelector(key === "recap" ? "#lpanelRecap" : "#lpanelDemandes").classList.add("active");
          });
        });

        renderRecapPanel();
        renderDemandesPanel();

        function renderRecapPanel() {
          var panel = modal.querySelector("#lpanelRecap");
          var recap = computeRecap(livreur.id, recapRange.start, recapRange.end);
          panel.innerHTML =
            '<div class="form-row" style="margin-top:10px;align-items:flex-end;">' +
              '<div class="field mb-0"><label>Du</label><input type="date" id="recapStart" value="' + recapRange.start + '" /></div>' +
              '<div class="field mb-0"><label>Au</label><input type="date" id="recapEnd" value="' + recapRange.end + '" /></div>' +
              '<div class="field mb-0"><button type="button" class="btn btn-secondary btn-sm" id="btnRecapGo">Actualiser</button></div>' +
            '</div>' +
            '<div class="grid grid-4" style="margin:14px 0;">' +
              kpi("check", "Heures travaillées", (Math.round(recap.heuresTotal * 10) / 10) + " h") +
              kpi("calendar", "Jours travaillés", DB.fmtNum(recap.counts.travail || 0)) +
              kpi("alert", "Jours heures sup.", DB.fmtNum(recap.joursSupTotal)) +
              kpi("wand", "Heures sup.", (Math.round(recap.heuresSupTotal * 10) / 10) + " h") +
            '</div>' +
            '<p class="text-sm text-faint">Seuil courant : au-delà de ' + recap.seuil + ' jour(s) travaillés sur une même semaine (lundi à dimanche), les jours suivants sont comptés comme heures supplémentaires.</p>' +
            '<h4 style="margin-top:18px;">Répartition par type de journée</h4>' +
            '<div class="table-wrap"><table><thead><tr><th>Type</th><th>Jours</th></tr></thead><tbody>' +
              allTypeKeys().map(function (k) {
                return '<tr><td>' + typeBadgeHtml(k) + '</td><td>' + DB.fmtNum(recap.counts[k] || 0) + '</td></tr>';
              }).join("") +
              // Types depuis supprimés de la liste de référence, mais encore présents sur des
              // jours de cette période : on les affiche aussi plutôt que de les faire disparaître.
              Object.keys(recap.counts).filter(function (k) { return allTypeKeys().indexOf(k) === -1 && recap.counts[k] > 0; }).map(function (k) {
                return '<tr><td>' + typeBadgeHtml(k) + '</td><td>' + DB.fmtNum(recap.counts[k]) + '</td></tr>';
              }).join("") +
            '</tbody></table></div>' +
            '<h4 style="margin-top:18px;">Détail par semaine</h4>' +
            (recap.weeks.length ?
              '<div class="table-wrap"><table><thead><tr><th>Semaine</th><th>Jours travaillés</th><th>Heures</th><th>Jours sup.</th><th>Heures sup.</th></tr></thead><tbody>' +
                recap.weeks.map(function (w) {
                  return '<tr>' +
                    '<td class="text-sm">' + DB.fmtDate(w.weekStart) + ' → ' + DB.fmtDate(w.weekEnd) + '</td>' +
                    '<td>' + w.joursTravail + '</td>' +
                    '<td>' + (Math.round(w.heures * 10) / 10) + ' h</td>' +
                    '<td>' + (w.joursSup ? '<span class="badge badge-warning">' + w.joursSup + '</span>' : '—') + '</td>' +
                    '<td>' + (w.heuresSup ? (Math.round(w.heuresSup * 10) / 10) + ' h' : '—') + '</td>' +
                  '</tr>';
                }).join("") +
              '</tbody></table></div>'
              : '<p class="text-faint text-sm">Aucun jour travaillé sur cette période.</p>');

          modal.querySelector("#btnRecapGo").addEventListener("click", function () {
            var s = modal.querySelector("#recapStart").value;
            var e = modal.querySelector("#recapEnd").value;
            if (!s || !e || s > e) { LM.toast("Période invalide.", "danger"); return; }
            recapRange = { start: s, end: e };
            renderRecapPanel();
          });
        }

        function renderDemandesPanel() {
          var panel = modal.querySelector("#lpanelDemandes");
          var rows = DB.list("demandesAbsence").filter(function (d) { return d.livreurId === livreur.id; })
            .sort(function (a, b) { return (b.dateDemande || "").localeCompare(a.dateDemande || ""); });

          panel.innerHTML =
            '<div class="card-header" style="margin-top:10px;"><div><p class="text-sm" style="margin:0;">' + rows.length + ' demande(s) enregistrée(s) pour ce livreur.</p></div>' +
              '<button class="btn btn-primary btn-sm" id="btnNewDemandeLiv">' + LM.icon("plus") + ' Nouvelle demande</button>' +
            '</div>' +
            (rows.length ?
              '<div class="table-wrap"><table><thead><tr><th>Date de la demande</th><th>Type</th><th>Jours concernés</th><th>Motif</th><th></th></tr></thead><tbody>' +
                rows.map(function (d) {
                  return '<tr>' +
                    '<td class="text-sm">' + DB.fmtDate(d.dateDemande) + '</td>' +
                    '<td>' + typeBadgeHtml(d.type) + '</td>' +
                    '<td class="text-sm">' + formatJoursCompact(d.jours) + '</td>' +
                    '<td class="text-sm">' + (d.motif ? LM.escapeHtml(d.motif) : '<span class="text-faint">—</span>') + '</td>' +
                    '<td class="actions"><button class="btn btn-ghost btn-sm btn-icon" data-editdem="' + d.id + '" title="Modifier">' + LM.icon("edit") + '</button></td>' +
                  '</tr>';
                }).join("") +
              '</tbody></table></div>'
              : '<p class="text-faint text-sm">Aucune demande enregistrée pour ce livreur.</p>');

          modal.querySelector("#btnNewDemandeLiv").addEventListener("click", function () {
            openDemandeForm(null, livreur.id);
          });
          panel.querySelectorAll("[data-editdem]").forEach(function (btn) {
            btn.addEventListener("click", function () {
              openDemandeForm(DB.get("demandesAbsence", btn.getAttribute("data-editdem")), livreur.id);
            });
          });
        }
      }
    });
  }

  // ------------------------------------------------------------------
  // Onglet Paramètres planning
  // ------------------------------------------------------------------
  function renderReglagesTab(panel) {
    var r = DB.getPlanningReglages();
    panel.innerHTML =
      '<div class="card-header" style="margin-top:6px;"><div><h3>Paramètres du planning</h3><p class="text-sm">Ces valeurs servent de référence par défaut pour les journées « Travail » et pour la génération automatique via « Proposer planning ».</p></div></div>' +
      '<form id="reglForm" style="max-width:560px;">' +
        '<div class="form-row">' +
          '<div class="field"><label>Heure de début</label><input type="time" name="heureDebut" value="' + LM.escapeHtml(r.heureDebut) + '" /></div>' +
          '<div class="field"><label>Heure de fin</label><input type="time" name="heureFin" value="' + LM.escapeHtml(r.heureFin) + '" /></div>' +
        '</div>' +
        '<div class="checkbox-row" style="margin-bottom:16px;">' +
          '<input type="checkbox" name="dimancheTravaille" id="reglDimanche"' + (r.dimancheTravaille ? " checked" : "") + ' />' +
          '<label for="reglDimanche" style="margin:0;">Le dimanche est travaillé par défaut</label>' +
        '</div>' +
        '<div class="checkbox-row" style="margin-bottom:14px;">' +
          '<input type="checkbox" name="pauseActive" id="reglPauseActive"' + (r.pauseActive ? " checked" : "") + ' />' +
          '<label for="reglPauseActive" style="margin:0;">Inclure une pause dans les journées de travail</label>' +
        '</div>' +
        '<div class="field" id="reglPauseDureeField"' + (!r.pauseActive ? ' style="display:none;"' : '') + '>' +
          '<label>Durée de la pause (minutes)</label><input type="number" name="pauseDuree" min="0" step="5" value="' + r.pauseDuree + '" />' +
        '</div>' +
        '<div class="field">' +
          '<label>Nombre de jours travaillés (par semaine) avant heures supplémentaires</label>' +
          '<input type="number" name="joursAvantHeuresSup" min="0" max="7" step="1" value="' + r.joursAvantHeuresSup + '" />' +
          '<p class="text-sm text-faint" style="margin-top:4px;">Au-delà de ce nombre de jours travaillés sur une même semaine (lundi à dimanche), les jours suivants sont comptés comme heures supplémentaires dans le récapitulatif du livreur.</p>' +
        '</div>' +
        '<button type="submit" class="btn btn-primary">Enregistrer les réglages</button>' +
      '</form>';

    var pauseCb = document.getElementById("reglPauseActive");
    pauseCb.addEventListener("change", function () {
      document.getElementById("reglPauseDureeField").style.display = pauseCb.checked ? "block" : "none";
    });

    document.getElementById("reglForm").addEventListener("submit", function (e) {
      e.preventDefault();
      var fd = new FormData(e.target);
      var patch = {
        heureDebut: fd.get("heureDebut") || "08:00",
        heureFin: fd.get("heureFin") || "17:00",
        dimancheTravaille: fd.get("dimancheTravaille") === "on",
        pauseActive: fd.get("pauseActive") === "on",
        pauseDuree: Number(fd.get("pauseDuree")) || 0,
        joursAvantHeuresSup: Math.max(0, Math.min(7, Number(fd.get("joursAvantHeuresSup"))))
      };
      if (!isFinite(patch.joursAvantHeuresSup) || fd.get("joursAvantHeuresSup") === "") patch.joursAvantHeuresSup = 5;
      DB.savePlanningReglages(patch);
      LM.toast("Réglages enregistrés.", "success");
    });
  }

  function kpi(iconName, label, value) {
    return '<div class="kpi"><div class="kpi-label"><span class="kpi-icon">' + LM.icon(iconName) + '</span>' + label + '</div><div class="kpi-value">' + value + '</div></div>';
  }
})();

/* ==== js/clients.js ==== */
/*! clients.js - Annuaire des clients livrés : liste, fiche détaillée (pop-up à onglets) et
    analyse simple de la liste (répartition, clients les plus touchés par des retards). */
(function () {
  "use strict";

  var searchQuery = "";

  App.registerPage("clients", { title: "Clients", subtitle: "Annuaire des clients livrés et analyse de la liste", render: render });

  // Nombre de signalements de retard (page Retards) mentionnant ce client.
  function retardsCountForClient(clientId) {
    return DB.list("retards").filter(function (r) { return DB.retardClientIds(r).indexOf(clientId) !== -1; }).length;
  }

  function render(content) {
    var clients = DB.list("clients").slice().sort(function (a, b) { return (a.nom || "").localeCompare(b.nom || ""); });
    var withRetard = clients.filter(function (c) { return retardsCountForClient(c.id) > 0; });
    var totalSignalements = DB.list("retards").reduce(function (a, r) { return a + DB.retardClientIds(r).length; }, 0);

    var villeCounts = {};
    clients.forEach(function (c) { var v = (c.ville || "").trim() || "Non renseignée"; villeCounts[v] = (villeCounts[v] || 0) + 1; });
    var topVille = Object.keys(villeCounts).sort(function (a, b) { return villeCounts[b] - villeCounts[a]; })[0] || "—";

    content.innerHTML =
      '<div class="grid grid-4" style="margin-bottom:22px;">' +
        kpiC("clients", "Clients enregistrés", DB.fmtNum(clients.length)) +
        kpiC("alert", "Clients avec retard signalé", DB.fmtNum(withRetard.length)) +
        kpiC("retard", "Signalements de retard (total)", DB.fmtNum(totalSignalements)) +
        kpiC("zones", "Ville la plus représentée", LM.escapeHtml(topVille)) +
      '</div>' +
      '<div class="grid grid-2" style="margin-bottom:22px;">' +
        '<div class="card"><h3>Top clients par retards signalés</h3><p class="text-sm">Sur l\'ensemble de l\'historique.</p><div id="chartTopClients" style="margin-top:10px;"></div></div>' +
        '<div class="card"><h3>Répartition par ville</h3><p class="text-sm">Nombre de clients par ville renseignée.</p><div id="chartVilles" style="margin-top:10px;"></div></div>' +
      '</div>' +
      '<div class="card">' +
        '<div class="card-header"><div><h2>Liste des clients</h2><p>' + clients.length + ' client(s) enregistré(s).</p></div>' +
          '<button class="btn btn-primary" id="btnNewClient">' + LM.icon("plus") + ' Nouveau client</button>' +
        '</div>' +
        '<div class="field" style="max-width:320px;"><label>Recherche</label><input type="search" id="clientSearch" placeholder="Nom, contact, ville…" value="' + LM.escapeHtml(searchQuery) + '" /></div>' +
        '<div class="table-wrap" style="margin-top:14px;"><table><thead><tr>' +
          '<th>Nom</th><th>Contact</th><th>Téléphone</th><th>Ville</th><th class="num">Retards signalés</th><th></th>' +
        '</tr></thead><tbody id="clientsBody"></tbody></table></div>' +
      '</div>';

    renderCharts(clients);
    renderRows();

    document.getElementById("btnNewClient").addEventListener("click", function () {
      openClientForm(null, null, function () { render(content); });
    });
    document.getElementById("clientSearch").addEventListener("input", function (e) { searchQuery = e.target.value; renderRows(); });

    function renderRows() {
      var q = DB.normalizeStr(searchQuery);
      var filtered = clients.filter(function (c) {
        if (!q) return true;
        var hay = DB.normalizeStr([c.nom, c.contact, c.ville, c.email].filter(Boolean).join(" "));
        return hay.indexOf(q) !== -1;
      });
      var tbody = document.getElementById("clientsBody");
      if (!filtered.length) { tbody.innerHTML = '<tr class="empty-row"><td colspan="6">Aucun client trouvé.</td></tr>'; return; }
      tbody.innerHTML = filtered.map(function (c) {
        var n = retardsCountForClient(c.id);
        return '<tr>' +
          '<td><strong>' + LM.escapeHtml(c.nom) + '</strong></td>' +
          '<td class="text-sm">' + (c.contact ? LM.escapeHtml(c.contact) : '<span class="text-faint">—</span>') + '</td>' +
          '<td class="text-sm">' + (c.telephone ? LM.escapeHtml(c.telephone) : '<span class="text-faint">—</span>') + '</td>' +
          '<td class="text-sm">' + (c.ville ? LM.escapeHtml(c.ville) : '<span class="text-faint">—</span>') + '</td>' +
          '<td class="num">' + (n ? '<span class="badge badge-warning">' + n + '</span>' : '<span class="text-faint">0</span>') + '</td>' +
          '<td class="actions">' +
            '<button class="btn btn-ghost btn-sm btn-icon" data-view="' + c.id + '" title="Voir">' + LM.icon("eye") + '</button>' +
            '<button class="btn btn-ghost btn-sm btn-icon" data-del="' + c.id + '" title="Supprimer">' + LM.icon("trash") + '</button>' +
          '</td>' +
        '</tr>';
      }).join("");
      tbody.querySelectorAll("[data-view]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          openClientDetailModal(DB.get("clients", btn.getAttribute("data-view")), function () { render(content); });
        });
      });
      tbody.querySelectorAll("[data-del]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var id = btn.getAttribute("data-del");
          var n = retardsCountForClient(id);
          var msg = n
            ? ("Ce client est mentionné dans " + n + " signalement(s) de retard. Il sera retiré de l'annuaire mais les signalements existants seront conservés (le nom du client n'y sera alors plus affiché). Continuer ?")
            : "Supprimer ce client ?";
          var cDel = DB.get("clients", id);
          LM.confirmDialog(msg, function () {
            DB.remove("clients", id);
            DB.logHistorique("Clients", "suppression", "Suppression client : " + (cDel ? cDel.nom : id));
            LM.toast("Client supprimé.", "success");
            render(content);
          });
        });
      });
    }
  }

  function renderCharts(clients) {
    var counts = clients.map(function (c) { return { label: c.nom, n: retardsCountForClient(c.id) }; })
      .filter(function (c) { return c.n > 0; })
      .sort(function (a, b) { return b.n - a.n; })
      .slice(0, 8);
    LMCharts.barChart(document.getElementById("chartTopClients"), {
      labels: counts.map(function (c) { return c.label; }),
      series: [{ name: "Retards signalés", data: counts.map(function (c) { return c.n; }) }],
      height: 240
    });

    var villeCounts = {};
    clients.forEach(function (c) { var v = (c.ville || "").trim() || "Non renseignée"; villeCounts[v] = (villeCounts[v] || 0) + 1; });
    var villeList = Object.keys(villeCounts).map(function (v) { return { label: v, value: villeCounts[v] }; }).sort(function (a, b) { return b.value - a.value; });
    LMCharts.donutChart(document.getElementById("chartVilles"), { data: villeList, height: 220 });
  }

  // ------------------------------------------------------------------
  // Formulaire d'ajout (pop-up à onglets). presetNom : pré-remplit le nom quand le formulaire est
  // ouvert depuis la création rapide d'un client sur la page Retards.
  // ------------------------------------------------------------------
  function openClientForm(existing, presetNom, onSaved) {
    var isEdit = !!existing;
    var c = existing || { nom: presetNom || "", contact: "", telephone: "", email: "", adresse: "", codePostal: "", ville: "", notes: "" };

    LM.openModal({
      title: isEdit ? "Modifier le client" : "Nouveau client",
      wide: true,
      bodyHtml:
        '<div class="tabs">' +
          '<button type="button" class="tab-btn active" data-ctab="coordonnees">Coordonnées</button>' +
          '<button type="button" class="tab-btn" data-ctab="adresse">Adresse &amp; notes</button>' +
        '</div>' +
        '<form id="clientForm">' +
          '<div id="ctabCoordonnees" class="tab-panel active">' +
            '<div class="field"><label>Nom du client *</label><input type="text" name="nom" value="' + LM.escapeHtml(c.nom) + '" required /></div>' +
            '<div class="form-row">' +
              '<div class="field"><label>Contact référent</label><input type="text" name="contact" value="' + LM.escapeHtml(c.contact) + '" /></div>' +
              '<div class="field"><label>Téléphone</label><input type="text" name="telephone" value="' + LM.escapeHtml(c.telephone) + '" /></div>' +
            '</div>' +
            '<div class="field"><label>Email</label><input type="email" name="email" value="' + LM.escapeHtml(c.email) + '" /></div>' +
          '</div>' +
          '<div id="ctabAdresse" class="tab-panel">' +
            '<div class="field"><label>Adresse</label><input type="text" name="adresse" value="' + LM.escapeHtml(c.adresse) + '" /></div>' +
            '<div class="form-row">' +
              '<div class="field"><label>Code postal</label><input type="text" name="codePostal" value="' + LM.escapeHtml(c.codePostal) + '" /></div>' +
              '<div class="field"><label>Ville</label><input type="text" name="ville" value="' + LM.escapeHtml(c.ville) + '" /></div>' +
            '</div>' +
            '<div class="field"><label>Notes</label><textarea name="notes">' + LM.escapeHtml(c.notes) + '</textarea></div>' +
          '</div>' +
        '</form>',
      footerHtml:
        '<button class="btn btn-secondary" id="cancelBtn">Annuler</button>' +
        '<button class="btn btn-primary" id="saveBtn">' + (isEdit ? "Enregistrer" : "Créer le client") + '</button>',
      onMount: function (modal) {
        modal.querySelectorAll("[data-ctab]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var key = btn.getAttribute("data-ctab");
            modal.querySelectorAll("[data-ctab]").forEach(function (b) { b.classList.toggle("active", b === btn); });
            modal.querySelectorAll(".tab-panel").forEach(function (p) { p.classList.remove("active"); });
            modal.querySelector(key === "coordonnees" ? "#ctabCoordonnees" : "#ctabAdresse").classList.add("active");
          });
        });
        modal.querySelector("#cancelBtn").addEventListener("click", LM.closeModal);
        modal.querySelector("#saveBtn").addEventListener("click", function () {
          var fd = new FormData(modal.querySelector("#clientForm"));
          var nom = (fd.get("nom") || "").toString().trim();
          if (!nom) { LM.toast("Le nom du client est obligatoire.", "danger"); return; }
          var payload = {
            nom: nom,
            contact: (fd.get("contact") || "").toString().trim(),
            telephone: (fd.get("telephone") || "").toString().trim(),
            email: (fd.get("email") || "").toString().trim(),
            adresse: (fd.get("adresse") || "").toString().trim(),
            codePostal: (fd.get("codePostal") || "").toString().trim(),
            ville: (fd.get("ville") || "").toString().trim(),
            notes: (fd.get("notes") || "").toString().trim()
          };
          var saved = isEdit ? DB.update("clients", c.id, payload) : DB.add("clients", payload);
          if (isEdit) {
            var changes = DB.summarizeFieldChanges(c, payload, { contact: "Contact", telephone: "Téléphone", email: "Email", adresse: "Adresse", codePostal: "Code postal", ville: "Ville" });
            DB.logHistorique("Clients", "modification", "Modification client : " + nom + (changes ? " -> " + changes : ""));
          } else {
            DB.logHistorique("Clients", "ajout", "Ajout client : " + nom);
          }
          LM.toast(isEdit ? "Client mis à jour." : "Client créé.", "success");
          LM.closeModal();
          if (typeof onSaved === "function") onSaved(saved);
        });
      }
    });
  }

  // ------------------------------------------------------------------
  // Fiche client (bouton "Voir") : pop-up à onglets Informations (édition) / Récapitulatif.
  // ------------------------------------------------------------------
  function openClientDetailModal(client, onChange) {
    if (!client) return;

    LM.openModal({
      title: LM.escapeHtml(client.nom),
      wide: true,
      bodyHtml:
        '<div class="tabs">' +
          '<button type="button" class="tab-btn active" data-cdtab="info">Informations</button>' +
          '<button type="button" class="tab-btn" data-cdtab="recap">Récapitulatif</button>' +
        '</div>' +
        '<div id="cdPanelInfo" class="tab-panel active"></div>' +
        '<div id="cdPanelRecap" class="tab-panel"></div>',
      footerHtml: '<button class="btn btn-secondary" id="closeBtn">Fermer</button>',
      onMount: function (modal) {
        modal.querySelector("#closeBtn").addEventListener("click", LM.closeModal);
        modal.querySelectorAll("[data-cdtab]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            modal.querySelectorAll("[data-cdtab]").forEach(function (b) { b.classList.toggle("active", b === btn); });
            modal.querySelectorAll(".tab-panel").forEach(function (p) { p.classList.remove("active"); });
            var key = btn.getAttribute("data-cdtab");
            modal.querySelector(key === "info" ? "#cdPanelInfo" : "#cdPanelRecap").classList.add("active");
          });
        });
        renderInfo();
        renderRecap();

        function renderInfo() {
          var panel = modal.querySelector("#cdPanelInfo");
          panel.innerHTML =
            '<form id="clientInfoForm" style="margin-top:14px;">' +
              '<div class="field"><label>Nom du client *</label><input type="text" name="nom" value="' + LM.escapeHtml(client.nom) + '" required /></div>' +
              '<div class="form-row">' +
                '<div class="field"><label>Contact référent</label><input type="text" name="contact" value="' + LM.escapeHtml(client.contact || "") + '" /></div>' +
                '<div class="field"><label>Téléphone</label><input type="text" name="telephone" value="' + LM.escapeHtml(client.telephone || "") + '" /></div>' +
              '</div>' +
              '<div class="field"><label>Email</label><input type="email" name="email" value="' + LM.escapeHtml(client.email || "") + '" /></div>' +
              '<div class="field"><label>Adresse</label><input type="text" name="adresse" value="' + LM.escapeHtml(client.adresse || "") + '" /></div>' +
              '<div class="form-row">' +
                '<div class="field"><label>Code postal</label><input type="text" name="codePostal" value="' + LM.escapeHtml(client.codePostal || "") + '" /></div>' +
                '<div class="field"><label>Ville</label><input type="text" name="ville" value="' + LM.escapeHtml(client.ville || "") + '" /></div>' +
              '</div>' +
              '<div class="field"><label>Notes</label><textarea name="notes">' + LM.escapeHtml(client.notes || "") + '</textarea></div>' +
              '<button type="submit" class="btn btn-primary">' + LM.icon("check") + ' Enregistrer les modifications</button>' +
            '</form>';
          panel.querySelector("#clientInfoForm").addEventListener("submit", function (e) {
            e.preventDefault();
            var fd = new FormData(e.target);
            var nom = (fd.get("nom") || "").toString().trim();
            if (!nom) { LM.toast("Le nom du client est obligatoire.", "danger"); return; }
            var beforeClient = client;
            var payload = {
              nom: nom,
              contact: (fd.get("contact") || "").toString().trim(),
              telephone: (fd.get("telephone") || "").toString().trim(),
              email: (fd.get("email") || "").toString().trim(),
              adresse: (fd.get("adresse") || "").toString().trim(),
              codePostal: (fd.get("codePostal") || "").toString().trim(),
              ville: (fd.get("ville") || "").toString().trim(),
              notes: (fd.get("notes") || "").toString().trim()
            };
            client = DB.update("clients", client.id, payload);
            var changes = DB.summarizeFieldChanges(beforeClient, payload, { contact: "Contact", telephone: "Téléphone", email: "Email", adresse: "Adresse", codePostal: "Code postal", ville: "Ville" });
            DB.logHistorique("Clients", "modification", "Modification client : " + nom + (changes ? " -> " + changes : ""));
            LM.toast("Client mis à jour.", "success");
            if (typeof onChange === "function") onChange();
          });
        }

        function renderRecap() {
          var panel = modal.querySelector("#cdPanelRecap");
          var retards = DB.list("retards").filter(function (r) { return DB.retardClientIds(r).indexOf(client.id) !== -1; })
            .slice().sort(function (a, b) { return (b.createdAt || "").localeCompare(a.createdAt || ""); });

          // Détail propre à ce client (temps de retard + justificatifs) pour chaque signalement.
          var clientEntries = retards.map(function (r) {
            var ce = (r.clients || []).filter(function (c) { return c.clientId === client.id; })[0];
            return { retard: r, tempsRetard: ce ? ce.tempsRetard : null, justifications: ce && Array.isArray(ce.justifications) ? ce.justifications : [] };
          });
          var tempsList = clientEntries.map(function (e) { return Number(e.tempsRetard); }).filter(function (t) { return isFinite(t) && t > 0; });
          var tempsMoyen = tempsList.length ? Math.round(tempsList.reduce(function (a, b) { return a + b; }, 0) / tempsList.length) : null;

          panel.innerHTML =
            '<div class="grid grid-2" style="margin:14px 0;">' +
              kpiC("retard", "Signalements de retard", DB.fmtNum(retards.length)) +
              kpiC("calendar", "Dernier signalement", retards.length ? (livDate(retards[0]) ? DB.fmtDate(livDate(retards[0])) : "—") : "—") +
            '</div>' +
            (tempsMoyen != null ?
              '<div class="grid grid-2" style="margin:0 0 14px;">' + kpiC("clock", "Temps de retard moyen", tempsMoyen + " min") + '</div>' : "") +
            (clientEntries.length ?
              '<div class="table-wrap"><table><thead><tr><th>Date</th><th>Entrepôt</th><th class="num">Temps de retard</th><th>Justificatifs</th><th>Commentaire</th></tr></thead><tbody>' +
                clientEntries.map(function (e) {
                  var r = e.retard;
                  var liv = DB.get("livraisons", r.livraisonId);
                  var justifsLabels = e.justifications.map(function (key) { return DB.listeLabel("motifsRetard", key) || "Justificatif supprimé"; });
                  return '<tr>' +
                    '<td class="text-sm">' + (liv ? DB.fmtDate(liv.date) : '<span class="text-faint">Entrée supprimée</span>') + '</td>' +
                    '<td class="text-sm">' + (liv ? LM.escapeHtml(liv.entrepotNom || DB.entrepotNom(liv.entrepotId) || "—") : "—") + '</td>' +
                    '<td class="num">' + (e.tempsRetard != null ? DB.fmtNum(e.tempsRetard) + " min" : '<span class="text-faint">—</span>') + '</td>' +
                    '<td class="text-sm">' + (justifsLabels.length ? LM.escapeHtml(justifsLabels.join(", ")) : '<span class="text-faint">—</span>') + '</td>' +
                    '<td class="text-sm">' + (r.commentaire ? LM.escapeHtml(r.commentaire) : '<span class="text-faint">—</span>') + '</td>' +
                  '</tr>';
                }).join("") +
              '</tbody></table></div>'
              : '<p class="text-faint text-sm" style="margin-top:14px;">Aucun retard signalé pour ce client.</p>');

          function livDate(r) { var liv = DB.get("livraisons", r.livraisonId); return liv ? liv.date : null; }
        }
      }
    });
  }

  function kpiC(iconName, label, value) {
    return '<div class="kpi"><div class="kpi-label"><span class="kpi-icon">' + LM.icon(iconName) + '</span>' + label + '</div><div class="kpi-value">' + value + '</div></div>';
  }
})();

/* ==== js/retards.js ==== */
/*! retards.js - Suivi des retards de livraison : même principe que la page Analyse (période,
    KPIs, graphiques), mais appliqué aux entrées du journal des livraisons (import Excel et
    saisie manuelle, page Analyse) pour y signaler le nombre de livraisons en retard et les
    clients concernés. */
(function () {
  "use strict";

  var period = { preset: "30j", start: null, end: null };
  var journalPage = 1;
  var PAGE_SIZE = 20;
  var onlyRetard = false;
  // Filtres locaux au journal (indépendants de la "Période d'analyse" ci-dessus) : permettent de
  // retrouver rapidement une ou plusieurs entrées par date, entrepôt et/ou livreur.
  var journalDateMode = "toutes"; // "toutes" (période ci-dessus) | "unique" | "periode"
  var journalDateSingle = DB.todayISO();
  var journalDateStart = null;
  var journalDateEnd = null;
  var journalEntIds = null; // null = tous ; sinon tableau d'ids (ou UNASSIGNED)
  var journalLivIds = null;
  var UNASSIGNED = "__non_attribue__";

  applyPreset("30j");
  App.registerPage("retards", { title: "Retards", subtitle: "Suivi des retards de livraison et des clients concernés", render: render });

  // ------------------------------------------------------------------
  // Période (même principe que la page Analyse)
  // ------------------------------------------------------------------
  function applyPreset(preset) {
    var end = new Date();
    var start = new Date();
    if (preset === "7j") { start.setDate(end.getDate() - 6); }
    else if (preset === "30j") { start.setDate(end.getDate() - 29); }
    else if (preset === "90j") { start.setDate(end.getDate() - 89); }
    else if (preset === "mois_courant") { start = new Date(end.getFullYear(), end.getMonth(), 1); }
    else if (preset === "mois_dernier") {
      start = new Date(end.getFullYear(), end.getMonth() - 1, 1);
      end = new Date(end.getFullYear(), end.getMonth(), 0);
    }
    period.preset = preset;
    period.start = start.toISOString().slice(0, 10);
    period.end = end.toISOString().slice(0, 10);
  }

  function livraisonsInRange(start, end) {
    return DB.list("livraisons").filter(function (r) { return r.date >= start && r.date <= end; });
  }

  function retardsInRange(start, end) {
    return DB.list("retards").filter(function (r) {
      var liv = DB.get("livraisons", r.livraisonId);
      return liv && liv.date >= start && liv.date <= end;
    });
  }

  function entrepotLabel(r) { return r.entrepotId ? (DB.entrepotNom(r.entrepotId) || r.entrepotNom || "Entrepôt inconnu") : (r.entrepotNom || "Non renseigné"); }
  function entrepotKey(r) { return r.entrepotId || ("n:" + DB.normalizeStr(r.entrepotNom || "")); }
  function livreurLabel(r) { return r.livreurId ? (DB.livreurNom(r.livreurId) || r.livreurNom || "Livreur inconnu") : (r.livreurNom || "Non renseigné"); }

  // ------------------------------------------------------------------
  // Rendu principal
  // ------------------------------------------------------------------
  function render(content) {
    content.innerHTML =
      '<div class="card">' +
        '<div class="card-header"><div><h2>Période d\'analyse</h2><p>Choisissez une période pour filtrer les statistiques de retard ci-dessous.</p></div>' +
          '<button class="btn btn-pdf" id="btnExportRetardsPdf">' + LM.icon("file") + ' Exporter en PDF</button>' +
        '</div>' +
        '<div class="flex gap-8" style="flex-wrap:wrap;margin-bottom:14px;" id="presetRow"></div>' +
        '<div class="form-row" id="customRow" style="' + (period.preset === "custom" ? "" : "display:none;") + '">' +
          '<div class="field"><label>Du</label><input type="date" id="customStart" value="' + period.start + '" /></div>' +
          '<div class="field"><label>Au</label><input type="date" id="customEnd" value="' + period.end + '" /></div>' +
          '<div class="field" style="align-self:flex-end;"><button class="btn btn-secondary" id="applyCustom">Appliquer</button></div>' +
        '</div>' +
      '</div>' +
      '<div class="grid grid-4" id="kpiRow" style="margin-bottom:14px;"></div>' +
      '<div class="grid grid-2" id="kpiRow2" style="margin-bottom:22px;"></div>' +
      '<div class="grid grid-2">' +
        '<div class="card"><h3>Livraisons en retard par jour</h3><p class="text-sm">Évolution sur la période sélectionnée.</p><div id="chartLine" style="margin-top:10px;"></div></div>' +
        '<div class="card"><h3>Retards par entrepôt</h3><p class="text-sm">Comparaison entre sites.</p><div id="chartBarEnt" style="margin-top:10px;"></div></div>' +
      '</div>' +
      '<div class="grid grid-2">' +
        '<div class="card"><h3>Top clients touchés</h3><p class="text-sm">Nombre de signalements par client sur la période.</p><div id="chartTopClients" style="margin-top:10px;"></div></div>' +
        '<div class="card"><h3>Entrées avec vs sans retard</h3><p class="text-sm">Part des entrées du journal concernées par un retard.</p><div id="chartDonut" style="margin-top:10px;"></div></div>' +
      '</div>' +
      '<div class="card"><h3>Retards par justificatif</h3><p class="text-sm">Nombre de fois où chaque justificatif a été sélectionné, sur la période (liste personnalisable depuis Annexes).</p><div id="chartMotifs" style="margin-top:10px;"></div></div>' +
      '<div class="card">' +
        '<div id="journalFilterCard"></div>' +
        '<div class="table-wrap"><table><thead><tr>' +
          '<th>Date</th><th>Entrepôt</th><th>Livreur</th><th class="num">Livraisons</th><th>Retard signalé</th><th>Clients concernés</th><th></th>' +
        '</tr></thead><tbody id="journalBody"></tbody></table></div>' +
        '<div class="flex gap-10" style="margin-top:14px;align-items:center;justify-content:flex-end;">' +
          '<button class="btn btn-secondary btn-sm" id="prevPage">Précédent</button>' +
          '<span class="text-sm" id="pageLabel"></span>' +
          '<button class="btn btn-secondary btn-sm" id="nextPage">Suivant</button>' +
        '</div>' +
      '</div>';

    renderPresetRow();
    renderKpis();
    renderCharts();
    renderJournalFilterCard();
    renderJournal();

    document.getElementById("btnExportRetardsPdf").addEventListener("click", openExportRetardsPdfModal);
  }

  // ------------------------------------------------------------------
  // Cadre de filtres du journal : case "uniquement les entrées signalées" + tri/filtre par
  // date, entrepôt et livreur. Redessiné à chaque changement pour afficher/masquer les champs
  // de date conditionnels et tenir à jour le bouton "Réinitialiser les filtres".
  // ------------------------------------------------------------------
  function renderJournalFilterCard() {
    var container = document.getElementById("journalFilterCard");
    var entrepots = DB.list("entrepots");
    var livreurs = DB.list("livreurs").slice().sort(function (a, b) { return DB.livreurNomComplet(a).localeCompare(DB.livreurNomComplet(b), "fr"); });
    var hasUnassignedEnt = DB.list("livraisons").some(function (r) { return !r.entrepotId; });
    var hasUnassignedLiv = DB.list("livraisons").some(function (r) { return !r.livreurId; });
    var filtersActive = journalDateMode !== "toutes" || journalEntIds !== null || journalLivIds !== null;

    container.innerHTML =
      '<div class="flex-between" style="margin-bottom:4px;">' +
        '<h2 style="margin:0;">Journal des livraisons</h2>' +
        (filtersActive ? '<button type="button" class="text-link" id="journalFilterResetBtn">Réinitialiser les filtres</button>' : "") +
      '</div>' +
      '<p class="text-sm" style="margin-top:2px;">Entrées reprises de la page Analyse (import Excel et saisie manuelle) : signalez-y le nombre de livraisons en retard et les clients concernés.</p>' +
      '<div class="checkbox-row" style="margin-bottom:14px;">' +
        '<input type="checkbox" id="onlyRetardCb"' + (onlyRetard ? " checked" : "") + ' />' +
        '<label for="onlyRetardCb" style="margin:0;">Afficher uniquement les entrées avec un retard signalé</label>' +
      '</div>' +
      '<div class="form-row" style="align-items:flex-end;">' +
        '<div class="field mb-0"><label>Trier / filtrer par date</label><select id="journalDateModeSelect">' +
          '<option value="toutes"' + (journalDateMode === "toutes" ? " selected" : "") + '>Période d\'analyse sélectionnée ci-dessus</option>' +
          '<option value="unique"' + (journalDateMode === "unique" ? " selected" : "") + '>Une date précise</option>' +
          '<option value="periode"' + (journalDateMode === "periode" ? " selected" : "") + '>Une période personnalisée</option>' +
        '</select></div>' +
        (journalDateMode === "unique" ?
          '<div class="field mb-0"><label>Date</label><input type="date" id="journalDateSingleInput" value="' + (journalDateSingle || "") + '" /></div>'
          : "") +
        (journalDateMode === "periode" ?
          '<div class="field mb-0"><label>Du</label><input type="date" id="journalDateStartInput" value="' + (journalDateStart || "") + '" /></div>' +
          '<div class="field mb-0"><label>Au</label><input type="date" id="journalDateEndInput" value="' + (journalDateEnd || "") + '" /></div>'
          : "") +
        (journalDateMode !== "toutes" ? '<div class="field mb-0"><button type="button" class="btn btn-secondary btn-sm" id="journalDateApplyBtn">Appliquer</button></div>' : "") +
      '</div>' +
      '<div class="form-row">' +
        '<div class="field mb-0"><label>Entrepôt(s)</label><select id="journalEntFilter" multiple size="4">' +
          entrepots.map(function (e) {
            var sel = journalEntIds === null || journalEntIds.indexOf(e.id) !== -1;
            return '<option value="' + e.id + '"' + (sel ? " selected" : "") + '>' + LM.escapeHtml(e.nom) + '</option>';
          }).join("") +
          (hasUnassignedEnt ? '<option value="' + UNASSIGNED + '"' + ((journalEntIds === null || journalEntIds.indexOf(UNASSIGNED) !== -1) ? " selected" : "") + '>Non reconnu / non renseigné</option>' : "") +
        '</select><div class="hint">Tous sélectionnés par défaut. Ctrl/Cmd + clic pour affiner.</div></div>' +
        '<div class="field mb-0"><label>Livreur(s)</label><select id="journalLivFilter" multiple size="4">' +
          livreurs.map(function (l) {
            var sel = journalLivIds === null || journalLivIds.indexOf(l.id) !== -1;
            return '<option value="' + l.id + '"' + (sel ? " selected" : "") + '>' + LM.escapeHtml(DB.livreurNomComplet(l)) + '</option>';
          }).join("") +
          (hasUnassignedLiv ? '<option value="' + UNASSIGNED + '"' + ((journalLivIds === null || journalLivIds.indexOf(UNASSIGNED) !== -1) ? " selected" : "") + '>Non renseigné</option>' : "") +
        '</select><div class="hint">Tous sélectionnés par défaut. Ctrl/Cmd + clic pour affiner.</div></div>' +
      '</div>';

    document.getElementById("onlyRetardCb").addEventListener("change", function (e) {
      onlyRetard = e.target.checked;
      journalPage = 1;
      renderJournalFilterCard();
      renderJournal();
    });

    document.getElementById("journalDateModeSelect").addEventListener("change", function (e) {
      journalDateMode = e.target.value;
      journalPage = 1;
      renderJournalFilterCard();
      renderJournal();
    });

    var journalDateApplyBtn = document.getElementById("journalDateApplyBtn");
    if (journalDateApplyBtn) {
      journalDateApplyBtn.addEventListener("click", function () {
        if (journalDateMode === "unique") {
          var v = document.getElementById("journalDateSingleInput").value;
          if (!v) { LM.toast("Merci de choisir une date.", "danger"); return; }
          journalDateSingle = v;
        } else if (journalDateMode === "periode") {
          var s = document.getElementById("journalDateStartInput").value;
          var e2 = document.getElementById("journalDateEndInput").value;
          if (!s || !e2 || s > e2) { LM.toast("Plage de dates invalide.", "danger"); return; }
          journalDateStart = s; journalDateEnd = e2;
        }
        journalPage = 1;
        renderJournal();
      });
    }

    document.getElementById("journalEntFilter").addEventListener("change", function (e) {
      var opts = Array.prototype.slice.call(e.target.selectedOptions).map(function (o) { return o.value; });
      journalEntIds = (opts.length === e.target.options.length) ? null : opts;
      journalPage = 1;
      renderJournalFilterCard();
      renderJournal();
    });

    document.getElementById("journalLivFilter").addEventListener("change", function (e) {
      var opts = Array.prototype.slice.call(e.target.selectedOptions).map(function (o) { return o.value; });
      journalLivIds = (opts.length === e.target.options.length) ? null : opts;
      journalPage = 1;
      renderJournalFilterCard();
      renderJournal();
    });

    var journalFilterResetBtn = document.getElementById("journalFilterResetBtn");
    if (journalFilterResetBtn) {
      journalFilterResetBtn.addEventListener("click", function () {
        journalDateMode = "toutes"; journalDateSingle = DB.todayISO(); journalDateStart = null; journalDateEnd = null;
        journalEntIds = null; journalLivIds = null; onlyRetard = false;
        journalPage = 1;
        renderJournalFilterCard();
        renderJournal();
      });
    }
  }

  // Applique les filtres locaux du journal (date / entrepôt / livreur / uniquement signalées).
  function journalFilteredRows() {
    var base;
    if (journalDateMode === "unique" && journalDateSingle) {
      base = livraisonsInRange(journalDateSingle, journalDateSingle);
    } else if (journalDateMode === "periode" && journalDateStart && journalDateEnd) {
      base = livraisonsInRange(journalDateStart, journalDateEnd);
    } else {
      base = livraisonsInRange(period.start, period.end);
    }
    if (onlyRetard) {
      base = base.filter(function (r) { var ret = DB.retardPourLivraison(r.id); return ret && (Number(ret.nbLivraisonsRetard) || 0) > 0; });
    }
    if (journalEntIds) {
      var entSet = {}; journalEntIds.forEach(function (id) { entSet[id] = true; });
      base = base.filter(function (r) { return !!entSet[r.entrepotId || UNASSIGNED]; });
    }
    if (journalLivIds) {
      var livSet = {}; journalLivIds.forEach(function (id) { livSet[id] = true; });
      base = base.filter(function (r) { return !!livSet[r.livreurId || UNASSIGNED]; });
    }
    return base;
  }

  // Statut d'étude du retard pour une entrée du journal, utilisé pour la pastille à côté du
  // bouton "Gérer les retards" :
  //  - rouge : non étudié du tout (aucun signalement enregistré) ;
  //  - orange : signalement incomplet — soit le nombre de clients renseignés ne correspond pas
  //    au nombre de retards déclarés (ex : 6 retards signalés mais seulement 4 clients ajoutés),
  //    soit au moins un client en retard n'a aucun justificatif (minimum 1 par client) ;
  //  - vert : entièrement documenté (autant de clients que de retards, chacun avec au moins un
  //    justificatif), ou explicitement marqué "Aucun retard".
  function retardDotStatus(r, ret) {
    if (!ret) return { cls: "warn", title: "Retards non étudiés pour cette entrée." };
    if (ret.aucunRetard) return { cls: "ok", title: "Étudié : aucun retard sur cette entrée." };
    var clients = Array.isArray(ret.clients) ? ret.clients : [];
    var nbClients = clients.length;
    var nbRetard = Number(ret.nbLivraisonsRetard) || 0;
    if (nbClients !== nbRetard) {
      return { cls: "missing", title: "À compléter : " + nbRetard + " retard(s) déclaré(s) pour seulement " + nbClients + " client(s) renseigné(s)." };
    }
    var sansJustif = clients.filter(function (c) { return !Array.isArray(c.justifications) || c.justifications.length === 0; }).length;
    if (sansJustif > 0) {
      return { cls: "missing", title: "Justificatif manquant pour " + sansJustif + " client(s) sur " + nbClients + "." };
    }
    return { cls: "ok", title: "Étudié : " + nbRetard + " retard(s) documenté(s) (" + nbClients + " client(s)), tous justifiés." };
  }

  function renderPresetRow() {
    var presets = [
      { key: "7j", label: "7 derniers jours" },
      { key: "30j", label: "30 derniers jours" },
      { key: "90j", label: "90 derniers jours" },
      { key: "mois_courant", label: "Mois en cours" },
      { key: "mois_dernier", label: "Mois dernier" },
      { key: "custom", label: "Période personnalisée" }
    ];
    var row = document.getElementById("presetRow");
    row.innerHTML = presets.map(function (p) {
      return '<button class="btn btn-sm ' + (period.preset === p.key ? "btn-primary" : "btn-secondary") + '" data-preset="' + p.key + '">' + p.label + '</button>';
    }).join("");
    row.querySelectorAll("[data-preset]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var key = btn.getAttribute("data-preset");
        if (key === "custom") {
          period.preset = "custom";
          document.getElementById("customRow").style.display = "";
          renderPresetRow();
          return;
        }
        applyPreset(key);
        renderPresetRow();
        renderKpis();
        renderCharts();
        journalPage = 1;
        renderJournal();
      });
    });
    var applyCustomBtn = document.getElementById("applyCustom");
    if (applyCustomBtn) {
      applyCustomBtn.addEventListener("click", function () {
        var s = document.getElementById("customStart").value;
        var e = document.getElementById("customEnd").value;
        if (!s || !e || s > e) { LM.toast("Plage de dates invalide.", "danger"); return; }
        period.preset = "custom"; period.start = s; period.end = e;
        renderKpis();
        renderCharts();
        journalPage = 1;
        renderJournal();
      });
    }
  }

  // ------------------------------------------------------------------
  // KPIs
  // ------------------------------------------------------------------
  function renderKpis() {
    var livRows = livraisonsInRange(period.start, period.end);
    var retRows = retardsInRange(period.start, period.end);

    var totalLivraisons = livRows.reduce(function (a, r) { return a + (Number(r.nbLivraisons) || 0); }, 0);
    var totalRetard = retRows.reduce(function (a, r) { return a + (Number(r.nbLivraisonsRetard) || 0); }, 0);
    var tauxRetard = totalLivraisons ? Math.round((totalRetard / totalLivraisons) * 1000) / 10 : 0;
    var entreesAvecRetard = retRows.filter(function (r) { return (Number(r.nbLivraisonsRetard) || 0) > 0; }).length;
    var clientsSet = {};
    retRows.forEach(function (r) { DB.retardClientIds(r).forEach(function (id) { clientsSet[id] = true; }); });

    document.getElementById("kpiRow").innerHTML =
      kpiR("retard", "Livraisons en retard", DB.fmtNum(totalRetard)) +
      kpiR("trend", "Taux de retard", tauxRetard + " %") +
      kpiR("alert", "Entrées avec retard signalé", DB.fmtNum(entreesAvecRetard)) +
      kpiR("clients", "Clients touchés", DB.fmtNum(Object.keys(clientsSet).length));

    // Temps de retard moyen et justificatif le plus fréquent : calculés client par client
    // (chacun porte désormais son propre temps de retard et jusqu'à 3 justificatifs).
    var tempsList = [];
    var motifsCount = {};
    retRows.forEach(function (r) {
      (r.clients || []).forEach(function (c) {
        var t = Number(c.tempsRetard);
        if (isFinite(t) && t > 0) tempsList.push(t);
        (c.justifications || []).forEach(function (key) { motifsCount[key] = (motifsCount[key] || 0) + 1; });
      });
    });
    var tempsMoyen = tempsList.length ? Math.round(tempsList.reduce(function (a, b) { return a + b; }, 0) / tempsList.length) : 0;
    var motifTop = Object.keys(motifsCount).sort(function (a, b) { return motifsCount[b] - motifsCount[a]; })[0];
    var motifTopLabel = motifTop ? ((DB.listeLabel("motifsRetard", motifTop) || "Justificatif supprimé") + " (" + motifsCount[motifTop] + ")") : "—";

    document.getElementById("kpiRow2").innerHTML =
      kpiR("clock", "Temps de retard moyen", tempsList.length ? (tempsMoyen + " min") : "—") +
      kpiR("tag", "Justificatif le plus fréquent", motifTopLabel);
  }

  // ------------------------------------------------------------------
  // Graphiques
  // ------------------------------------------------------------------
  function renderCharts() {
    var livRows = livraisonsInRange(period.start, period.end);
    var retRows = retardsInRange(period.start, period.end);
    var livById = {};
    livRows.forEach(function (r) { livById[r.id] = r; });

    // Ligne : retards par jour
    var byDay = {};
    retRows.forEach(function (r) {
      var liv = DB.get("livraisons", r.livraisonId);
      if (!liv) return;
      byDay[liv.date] = (byDay[liv.date] || 0) + (Number(r.nbLivraisonsRetard) || 0);
    });
    var days = [];
    var d0 = new Date(period.start), d1 = new Date(period.end);
    for (var d = new Date(d0); d <= d1; d.setDate(d.getDate() + 1)) days.push(d.toISOString().slice(0, 10));
    LMCharts.lineChart(document.getElementById("chartLine"), {
      labels: days.map(function (iso) { return iso.slice(8, 10) + "/" + iso.slice(5, 7); }),
      series: [{ name: "Livraisons en retard", data: days.map(function (iso) { return byDay[iso] || 0; }) }],
      height: 260
    });

    // Barres : retards par entrepôt
    var byEnt = {};
    retRows.forEach(function (r) {
      var liv = DB.get("livraisons", r.livraisonId);
      if (!liv) return;
      var k = entrepotKey(liv);
      if (!byEnt[k]) byEnt[k] = { label: entrepotLabel(liv), n: 0 };
      byEnt[k].n += Number(r.nbLivraisonsRetard) || 0;
    });
    var entList = Object.keys(byEnt).map(function (k) { return byEnt[k]; }).sort(function (a, b) { return b.n - a.n; });
    LMCharts.barChart(document.getElementById("chartBarEnt"), {
      labels: entList.map(function (e) { return e.label; }),
      series: [{ name: "Livraisons en retard", data: entList.map(function (e) { return e.n; }) }],
      height: 260
    });

    // Top clients touchés
    var byClient = {};
    retRows.forEach(function (r) {
      DB.retardClientIds(r).forEach(function (id) {
        if (!byClient[id]) byClient[id] = { label: DB.clientNom(id) || "Client supprimé", n: 0 };
        byClient[id].n++;
      });
    });
    var clientList = Object.keys(byClient).map(function (k) { return byClient[k]; }).sort(function (a, b) { return b.n - a.n; }).slice(0, 8);
    LMCharts.barChart(document.getElementById("chartTopClients"), {
      labels: clientList.map(function (c) { return c.label; }),
      series: [{ name: "Signalements", data: clientList.map(function (c) { return c.n; }) }],
      height: 260
    });

    // Donut : entrées avec vs sans retard
    var withRetard = retRows.filter(function (r) { return (Number(r.nbLivraisonsRetard) || 0) > 0; }).length;
    var withoutRetard = Math.max(0, livRows.length - withRetard);
    LMCharts.donutChart(document.getElementById("chartDonut"), {
      data: [
        { label: "Sans retard signalé", value: withoutRetard },
        { label: "Avec retard signalé", value: withRetard }
      ],
      height: 240
    });

    // Barres : retards par justificatif (liste personnalisable depuis Annexes)
    var byMotif = {};
    retRows.forEach(function (r) {
      (r.clients || []).forEach(function (c) {
        (c.justifications || []).forEach(function (key) {
          if (!byMotif[key]) byMotif[key] = { label: DB.listeLabel("motifsRetard", key) || "Justificatif supprimé", n: 0 };
          byMotif[key].n++;
        });
      });
    });
    var motifList = Object.keys(byMotif).map(function (k) { return byMotif[k]; }).sort(function (a, b) { return b.n - a.n; });
    LMCharts.barChart(document.getElementById("chartMotifs"), {
      labels: motifList.map(function (m) { return m.label; }),
      series: [{ name: "Sélections", data: motifList.map(function (m) { return m.n; }) }],
      height: 260
    });
  }

  // ------------------------------------------------------------------
  // Journal (entrées reprises de la page Analyse)
  // ------------------------------------------------------------------
  function renderJournal() {
    var all = journalFilteredRows().sort(function (a, b) { return b.date.localeCompare(a.date); });
    var totalPages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
    if (journalPage > totalPages) journalPage = totalPages;
    var pageRows = all.slice((journalPage - 1) * PAGE_SIZE, journalPage * PAGE_SIZE);

    document.getElementById("pageLabel").textContent = "Page " + journalPage + " / " + totalPages + " (" + all.length + " entrée(s))";
    document.getElementById("prevPage").disabled = journalPage <= 1;
    document.getElementById("nextPage").disabled = journalPage >= totalPages;

    var tbody = document.getElementById("journalBody");
    if (!pageRows.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="7">Aucune entrée sur cette période.</td></tr>';
    } else {
      tbody.innerHTML = pageRows.map(function (r) {
        var ret = DB.retardPourLivraison(r.id);
        var n = ret ? (Number(ret.nbLivraisonsRetard) || 0) : 0;
        var clientsNoms = ret ? DB.retardClientIds(ret).map(function (id) { return DB.clientNom(id) || "Client supprimé"; }) : [];
        var dot = retardDotStatus(r, ret);
        var statutHtml = ret && ret.aucunRetard ?
          '<span class="badge badge-success">Aucun retard</span>' :
          (n > 0 ? '<span class="badge badge-warning">' + n + ' en retard</span>' : '<span class="text-faint">Aucun</span>');
        return '<tr>' +
          '<td>' + DB.fmtDate(r.date) + '</td>' +
          '<td>' + LM.escapeHtml(entrepotLabel(r)) + '</td>' +
          '<td>' + LM.escapeHtml(livreurLabel(r)) + '</td>' +
          '<td class="num">' + DB.fmtNum(r.nbLivraisons) + '</td>' +
          '<td>' + statutHtml + '</td>' +
          '<td class="text-sm">' + (clientsNoms.length ? LM.escapeHtml(clientsNoms.join(", ")) : '<span class="text-faint">—</span>') + '</td>' +
          '<td class="actions">' +
            '<span class="retard-dot retard-dot-' + dot.cls + '" title="' + LM.escapeHtml(dot.title) + '"></span>' +
            '<button class="btn btn-ghost btn-sm btn-icon" data-manage="' + r.id + '" title="Gérer les retards">' + LM.icon("retard") + '</button>' +
          '</td>' +
        '</tr>';
      }).join("");
      tbody.querySelectorAll("[data-manage]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var row = DB.get("livraisons", btn.getAttribute("data-manage"));
          if (row) openRetardForm(row, function () { renderKpis(); renderCharts(); renderJournal(); });
        });
      });
    }

    var prevBtn = document.getElementById("prevPage"), nextBtn = document.getElementById("nextPage");
    prevBtn.onclick = function () { journalPage--; renderJournal(); };
    nextBtn.onclick = function () { journalPage++; renderJournal(); };
  }

  // ------------------------------------------------------------------
  // Export PDF : statistiques de retard + détail des signalements sur la période choisie,
  // filtrables par entrepôt et livreur, avec sections activables.
  // ------------------------------------------------------------------
  function openExportRetardsPdfModal() {
    var entrepots = DB.list("entrepots");
    var livreurs = DB.list("livreurs").slice().sort(function (a, b) { return DB.livreurNomComplet(a).localeCompare(DB.livreurNomComplet(b), "fr"); });
    var hasUnassignedEnt = DB.list("livraisons").some(function (r) { return !r.entrepotId; });
    var hasUnassignedLiv = DB.list("livraisons").some(function (r) { return !r.livreurId; });

    LM.openModal({
      title: "Exporter les retards en PDF",
      wide: true,
      bodyHtml:
        '<p class="text-sm text-faint" style="margin-top:0;">Générez un rapport PDF des retards signalés, filtré par période, entrepôt et livreur.</p>' +
        '<div class="form-row">' +
          '<div class="field"><label>Du</label><input type="date" id="retPdfStart" value="' + period.start + '" /></div>' +
          '<div class="field"><label>Au</label><input type="date" id="retPdfEnd" value="' + period.end + '" /></div>' +
        '</div>' +
        '<div class="form-row">' +
          '<div class="field"><label>Entrepôts à inclure</label><select id="retPdfEnt" multiple size="6">' +
            entrepots.map(function (e) { return '<option value="' + e.id + '" selected>' + LM.escapeHtml(e.nom) + '</option>'; }).join("") +
            (hasUnassignedEnt ? '<option value="' + UNASSIGNED + '" selected>Non reconnu / non renseigné</option>' : "") +
          '</select><div class="hint">Tous sélectionnés par défaut. Ctrl/Cmd + clic pour affiner.</div></div>' +
          '<div class="field"><label>Livreurs à inclure</label><select id="retPdfLiv" multiple size="6">' +
            livreurs.map(function (l) { return '<option value="' + l.id + '" selected>' + LM.escapeHtml(DB.livreurNomComplet(l)) + '</option>'; }).join("") +
            (hasUnassignedLiv ? '<option value="' + UNASSIGNED + '" selected>Non renseigné</option>' : "") +
          '</select><div class="hint">Tous sélectionnés par défaut. Ctrl/Cmd + clic pour affiner.</div></div>' +
        '</div>' +
        '<div class="field">' +
          '<label class="checkbox-row" style="margin-bottom:8px;"><input type="checkbox" id="retPdfOnly"' + (onlyRetard ? " checked" : "") + ' /> N\'inclure dans le détail que les entrées avec un retard signalé</label>' +
        '</div>' +
        '<div class="field">' +
          '<label>Sections à inclure</label>' +
          [
            { key: "kpis", label: "Indicateurs clés (KPI)" },
            { key: "entrepots", label: "Retards par entrepôt" },
            { key: "clients", label: "Top clients touchés" },
            { key: "motifs", label: "Retards par justificatif" },
            { key: "detail", label: "Détail des signalements" }
          ].map(function (s) {
            return '<label class="checkbox-row" style="margin-bottom:8px;"><input type="checkbox" data-retpdfsection="' + s.key + '" checked /> ' + s.label + '</label>';
          }).join("") +
        '</div>',
      footerHtml:
        '<button class="btn btn-secondary" id="cancelBtn">Annuler</button>' +
        '<button class="btn btn-pdf" id="retPdfGo">' + LM.icon("file") + ' Générer le PDF</button>',
      onMount: function (modal) {
        modal.querySelector("#cancelBtn").addEventListener("click", LM.closeModal);
        modal.querySelector("#retPdfGo").addEventListener("click", function () {
          var start = modal.querySelector("#retPdfStart").value;
          var end = modal.querySelector("#retPdfEnd").value;
          if (!start || !end || start > end) { LM.toast("Période invalide.", "danger"); return; }

          var entSelect = modal.querySelector("#retPdfEnt");
          var entOpts = Array.prototype.slice.call(entSelect.selectedOptions);
          if (!entOpts.length) { LM.toast("Sélectionnez au moins un entrepôt.", "danger"); return; }
          var entSet = {}; entOpts.forEach(function (o) { entSet[o.value] = true; });
          var entTotal = entSelect.options.length;

          var livSelect = modal.querySelector("#retPdfLiv");
          var livOpts = Array.prototype.slice.call(livSelect.selectedOptions);
          if (!livOpts.length) { LM.toast("Sélectionnez au moins un livreur.", "danger"); return; }
          var livSet = {}; livOpts.forEach(function (o) { livSet[o.value] = true; });
          var livTotal = livSelect.options.length;

          var sections = {};
          Array.prototype.slice.call(modal.querySelectorAll("[data-retpdfsection]")).forEach(function (cb) {
            sections[cb.getAttribute("data-retpdfsection")] = cb.checked;
          });
          if (!Object.keys(sections).some(function (k) { return sections[k]; })) { LM.toast("Sélectionnez au moins une section à inclure.", "danger"); return; }

          var onlySignaled = modal.querySelector("#retPdfOnly").checked;

          LM.closeModal();
          exportRetardsPdf({
            start: start, end: end,
            entSet: entSet, entAll: entTotal === entOpts.length,
            livSet: livSet, livAll: livTotal === livOpts.length,
            onlySignaled: onlySignaled,
            sections: sections
          });
        });
      }
    });
  }

  function exportRetardsPdf(f) {
    function matchesFilters(liv) {
      var entKey = liv.entrepotId || UNASSIGNED;
      var livKey = liv.livreurId || UNASSIGNED;
      return !!f.entSet[entKey] && !!f.livSet[livKey];
    }

    var livRows = livraisonsInRange(f.start, f.end).filter(matchesFilters);
    var retRows = retardsInRange(f.start, f.end).filter(function (r) {
      var liv = DB.get("livraisons", r.livraisonId);
      return liv && matchesFilters(liv);
    });

    var periodeLabel = "Période : " + DB.fmtDate(f.start) + " → " + DB.fmtDate(f.end);
    var entLabel = "Entrepôts : " + (f.entAll ? "tous" : "sélection personnalisée");
    var livLabel = "Livreurs : " + (f.livAll ? "tous" : "sélection personnalisée");
    var subtitle = LM.escapeHtml(periodeLabel + "\n" + entLabel + " — " + livLabel);

    var totalLivraisons = livRows.reduce(function (a, r) { return a + (Number(r.nbLivraisons) || 0); }, 0);
    var totalRetard = retRows.reduce(function (a, r) { return a + (Number(r.nbLivraisonsRetard) || 0); }, 0);
    var tauxRetard = totalLivraisons ? Math.round((totalRetard / totalLivraisons) * 1000) / 10 : 0;
    var entreesAvecRetard = retRows.filter(function (r) { return (Number(r.nbLivraisonsRetard) || 0) > 0; }).length;
    var clientsSet = {};
    retRows.forEach(function (r) { DB.retardClientIds(r).forEach(function (id) { clientsSet[id] = true; }); });
    var tempsList = [];
    var motifsCount = {};
    retRows.forEach(function (r) {
      (r.clients || []).forEach(function (c) {
        var t = Number(c.tempsRetard);
        if (isFinite(t) && t > 0) tempsList.push(t);
        (c.justifications || []).forEach(function (key) { motifsCount[key] = (motifsCount[key] || 0) + 1; });
      });
    });
    var tempsMoyen = tempsList.length ? Math.round(tempsList.reduce(function (a, b) { return a + b; }, 0) / tempsList.length) : 0;
    var motifTop = Object.keys(motifsCount).sort(function (a, b) { return motifsCount[b] - motifsCount[a]; })[0];
    var motifTopLabel = motifTop ? ((DB.listeLabel("motifsRetard", motifTop) || "Justificatif supprimé") + " (" + motifsCount[motifTop] + ")") : "—";

    var body = "";

    if (f.sections.kpis) {
      body += '<div class="pr-kpis">' +
          '<div class="pr-kpi"><div class="pr-kpi-label">Livraisons en retard</div><div class="pr-kpi-value">' + DB.fmtNum(totalRetard) + '</div></div>' +
          '<div class="pr-kpi"><div class="pr-kpi-label">Taux de retard</div><div class="pr-kpi-value">' + tauxRetard + ' %</div></div>' +
          '<div class="pr-kpi"><div class="pr-kpi-label">Entrées avec retard signalé</div><div class="pr-kpi-value">' + DB.fmtNum(entreesAvecRetard) + '</div></div>' +
          '<div class="pr-kpi"><div class="pr-kpi-label">Clients touchés</div><div class="pr-kpi-value">' + DB.fmtNum(Object.keys(clientsSet).length) + '</div></div>' +
        '</div>' +
        '<div class="pr-kpis">' +
          '<div class="pr-kpi"><div class="pr-kpi-label">Temps de retard moyen</div><div class="pr-kpi-value">' + (tempsList.length ? tempsMoyen + " min" : "—") + '</div></div>' +
          '<div class="pr-kpi"><div class="pr-kpi-label">Justificatif le plus fréquent</div><div class="pr-kpi-value" style="font-size:14px;">' + LM.escapeHtml(motifTopLabel) + '</div></div>' +
        '</div>';
    }

    if (f.sections.entrepots) {
      var byEnt = {};
      retRows.forEach(function (r) {
        var liv = DB.get("livraisons", r.livraisonId);
        if (!liv) return;
        var k = entrepotKey(liv);
        if (!byEnt[k]) byEnt[k] = { label: entrepotLabel(liv), n: 0 };
        byEnt[k].n += Number(r.nbLivraisonsRetard) || 0;
      });
      var entList = Object.keys(byEnt).map(function (k) { return byEnt[k]; }).sort(function (a, b) { return b.n - a.n; });
      body += '<div class="pr-section-title">Retards par entrepôt</div>' +
        (entList.length ?
          '<table class="pr-table"><thead><tr><th>Entrepôt</th><th>Livraisons en retard</th></tr></thead><tbody>' +
            entList.map(function (e) { return '<tr><td>' + LM.escapeHtml(e.label) + '</td><td>' + DB.fmtNum(e.n) + '</td></tr>'; }).join("") +
          '</tbody></table>' : '<p class="pr-empty">Aucun retard signalé sur cette période.</p>');
    }

    if (f.sections.clients) {
      var byClient = {};
      retRows.forEach(function (r) {
        DB.retardClientIds(r).forEach(function (id) {
          if (!byClient[id]) byClient[id] = { label: DB.clientNom(id) || "Client supprimé", n: 0 };
          byClient[id].n++;
        });
      });
      var clientList = Object.keys(byClient).map(function (k) { return byClient[k]; }).sort(function (a, b) { return b.n - a.n; });
      body += '<div class="pr-section-title">Top clients touchés</div>' +
        (clientList.length ?
          '<table class="pr-table"><thead><tr><th>Client</th><th>Signalements</th></tr></thead><tbody>' +
            clientList.map(function (c) { return '<tr><td>' + LM.escapeHtml(c.label) + '</td><td>' + DB.fmtNum(c.n) + '</td></tr>'; }).join("") +
          '</tbody></table>' : '<p class="pr-empty">Aucun client concerné sur cette période.</p>');
    }

    if (f.sections.motifs) {
      var byMotif = {};
      retRows.forEach(function (r) {
        (r.clients || []).forEach(function (c) {
          (c.justifications || []).forEach(function (key) {
            if (!byMotif[key]) byMotif[key] = { label: DB.listeLabel("motifsRetard", key) || "Justificatif supprimé", n: 0 };
            byMotif[key].n++;
          });
        });
      });
      var motifList = Object.keys(byMotif).map(function (k) { return byMotif[k]; }).sort(function (a, b) { return b.n - a.n; });
      body += '<div class="pr-section-title">Retards par justificatif</div>' +
        (motifList.length ?
          '<table class="pr-table"><thead><tr><th>Justificatif</th><th>Sélections</th></tr></thead><tbody>' +
            motifList.map(function (m) { return '<tr><td>' + LM.escapeHtml(m.label) + '</td><td>' + DB.fmtNum(m.n) + '</td></tr>'; }).join("") +
          '</tbody></table>' : '<p class="pr-empty">Aucun justificatif renseigné sur cette période.</p>');
    }

    if (f.sections.detail) {
      var detailRows = livRows.slice();
      if (f.onlySignaled) {
        detailRows = detailRows.filter(function (r) { var ret = DB.retardPourLivraison(r.id); return ret && (Number(ret.nbLivraisonsRetard) || 0) > 0; });
      }
      detailRows.sort(function (a, b) { return a.date.localeCompare(b.date); });
      body += '<div class="pr-section-title">Détail des signalements (' + detailRows.length + ')</div>' +
        (detailRows.length ?
          '<table class="pr-table"><thead><tr><th>Date</th><th>Entrepôt</th><th>Livreur</th><th>Livraisons</th><th>Retard signalé</th><th>Clients concernés</th></tr></thead><tbody>' +
            detailRows.map(function (r) {
              var ret = DB.retardPourLivraison(r.id);
              var n = ret ? (Number(ret.nbLivraisonsRetard) || 0) : 0;
              var clientsNoms = ret ? DB.retardClientIds(ret).map(function (id) { return DB.clientNom(id) || "Client supprimé"; }) : [];
              return '<tr>' +
                '<td>' + DB.fmtDate(r.date) + '</td>' +
                '<td>' + LM.escapeHtml(entrepotLabel(r)) + '</td>' +
                '<td>' + LM.escapeHtml(livreurLabel(r)) + '</td>' +
                '<td>' + DB.fmtNum(r.nbLivraisons) + '</td>' +
                '<td>' + (n > 0 ? '<span class="pr-badge pr-badge-warning">' + n + ' en retard</span>' : '<span class="pr-desc">Aucun</span>') + '</td>' +
                '<td>' + (clientsNoms.length ? LM.escapeHtml(clientsNoms.join(", ")) : '<span class="pr-desc">—</span>') + '</td>' +
              '</tr>';
            }).join("") +
          '</tbody></table>' : '<p class="pr-empty">Aucune entrée ne correspond aux filtres sélectionnés.</p>');
    }

    LM.printReport("Suivi des retards", body, { subtitle: subtitle });
  }

  // ------------------------------------------------------------------
  // Pop-up "Gérer les retards" pour une entrée du journal : nombre de livraisons en retard et
  // clients concernés. Si un client tapé n'existe pas encore dans l'annuaire, propose de le
  // créer directement (sans quitter cette pop-up) via un petit formulaire qui apparaît en ligne.
  // ------------------------------------------------------------------
  function openRetardForm(livraisonRow, onSaved) {
    var existing = DB.retardPourLivraison(livraisonRow.id);

    LM.openModal({
      title: "Retards — " + DB.fmtDate(livraisonRow.date),
      wide: true,
      bodyHtml:
        '<form id="retForm">' +
          '<div class="card" style="background:var(--color-surface-alt);margin-bottom:16px;">' +
            '<p class="text-sm" style="margin:0 0 4px;"><strong>' + LM.escapeHtml(entrepotLabel(livraisonRow)) + '</strong>' + (livraisonRow.livreurId || livraisonRow.livreurNom ? ' — ' + LM.escapeHtml(livreurLabel(livraisonRow)) : '') + '</p>' +
            '<p class="text-sm text-faint" style="margin:0;">' + DB.fmtNum(livraisonRow.nbLivraisons) + ' livraison(s) au total sur cette entrée.</p>' +
          '</div>' +
          '<label class="checkbox-row" style="margin-bottom:16px;"><input type="checkbox" id="retAucunCb"' + (existing && existing.aucunRetard ? " checked" : "") + ' /><span>Aucun retard sur cette entrée</span></label>' +
          '<div id="retDetailsSection"' + (existing && existing.aucunRetard ? ' style="display:none;"' : '') + '>' +
            '<div class="field"><label>Nombre de livraisons en retard sur cette entrée</label>' +
              '<input type="number" name="nbLivraisonsRetard" min="0" max="' + (Number(livraisonRow.nbLivraisons) || 0) + '" value="' + (existing ? existing.nbLivraisonsRetard : 0) + '" />' +
            '</div>' +
            '<div class="field">' +
              '<label>Clients ayant eu du retard</label>' +
              '<p class="text-sm text-faint" style="margin-top:-4px;">Pour chaque client ajouté, précisez son temps de retard et jusqu\'à 3 justificatifs (liste personnalisable depuis Annexes).</p>' +
              '<div class="form-row" style="align-items:flex-end;margin-bottom:8px;">' +
                '<div class="field mb-0 client-search-field" style="flex:2;">' +
                  '<input type="text" id="retClientInput" placeholder="Rechercher par nom, adresse ou téléphone…" autocomplete="off" />' +
                  '<div id="retClientResults" class="client-search-results"></div>' +
                '</div>' +
                '<div class="field mb-0"><button type="button" class="btn btn-secondary btn-sm" id="btnAddRetClient">' + LM.icon("plus") + ' Ajouter</button></div>' +
              '</div>' +
              '<div id="retNewClientPanel" class="card" style="display:none;margin-bottom:12px;background:var(--color-surface-alt);">' +
                '<p class="text-sm" style="margin-top:0;">Ce client n\'existe pas encore dans l\'annuaire. Renseignez ses informations pour l\'ajouter : une fois créé, il sera placé en tête de la liste ci-dessous.</p>' +
                '<div class="field"><label>Nom du client *</label><input type="text" id="ncNom" /></div>' +
                '<div class="form-row">' +
                  '<div class="field"><label>Contact référent</label><input type="text" id="ncContact" /></div>' +
                  '<div class="field"><label>Téléphone</label><input type="text" id="ncTelephone" /></div>' +
                '</div>' +
                '<div class="field"><label>Adresse</label><input type="text" id="ncAdresse" placeholder="N°, rue…" /></div>' +
                '<div class="field"><label>Ville</label><input type="text" id="ncVille" /></div>' +
                '<div class="flex gap-10">' +
                  '<button type="button" class="btn btn-primary btn-sm" id="btnCreateNewClient">' + LM.icon("check") + ' Créer et ajouter</button>' +
                  '<button type="button" class="btn btn-ghost btn-sm" id="btnCancelNewClient">Annuler</button>' +
                '</div>' +
              '</div>' +
              '<div id="retClientChips"></div>' +
            '</div>' +
          '</div>' +
          '<div class="field"><label>Commentaire</label><textarea name="commentaire" placeholder="Optionnel">' + LM.escapeHtml(existing ? (existing.commentaire || "") : "") + '</textarea></div>' +
        '</form>',
      footerHtml:
        '<button class="btn btn-secondary" id="cancelBtn">Annuler</button>' +
        (existing ? '<button class="btn btn-danger" id="deleteBtn">Supprimer le signalement</button>' : '') +
        '<button class="btn btn-primary" id="saveBtn">Enregistrer</button>',
      onMount: function (modal) {
        // Chaque client sélectionné porte son propre temps de retard (minutes) et jusqu'à 3
        // justificatifs choisis dans la liste personnalisable de la page Annexes.
        var selectedClients = (existing && Array.isArray(existing.clients)) ? existing.clients.map(function (c) {
          return { clientId: c.clientId, tempsRetard: (c.tempsRetard != null ? c.tempsRetard : null), justifications: Array.isArray(c.justifications) ? c.justifications.slice() : [] };
        }) : [];
        renderChips();

        var clientInput = modal.querySelector("#retClientInput");
        var clientResults = modal.querySelector("#retClientResults");

        // Ajoute un client en tête de liste (le dernier ajouté doit toujours apparaître en
        // premier), qu'il vienne d'un résultat de recherche, du bouton "Ajouter" ou de la
        // création d'une nouvelle fiche client.
        function addSelectedClient(clientId) {
          if (selectedClients.some(function (sc) { return sc.clientId === clientId; })) {
            LM.toast("Ce client est déjà dans la liste.", "info");
            return false;
          }
          selectedClients.unshift({ clientId: clientId, tempsRetard: null, justifications: [] });
          renderChips();
          return true;
        }

        function hideClientResults() {
          clientResults.style.display = "none";
          clientResults.innerHTML = "";
        }

        function renderClientResults(query) {
          var q = DB.normalizeStr(query);
          if (!q) { hideClientResults(); return; }
          var matches = DB.list("clients").filter(function (c) {
            return DB.normalizeStr(c.nom).indexOf(q) !== -1 ||
              DB.normalizeStr(c.adresse || "").indexOf(q) !== -1 ||
              DB.normalizeStr(c.ville || "").indexOf(q) !== -1 ||
              DB.normalizeStr(c.telephone || "").indexOf(q) !== -1;
          }).sort(function (a, b) {
            // Priorité aux noms qui commencent par la recherche, puis ordre alphabétique.
            var an = DB.normalizeStr(a.nom), bn = DB.normalizeStr(b.nom);
            var aStarts = an.indexOf(q) === 0 ? 0 : 1, bStarts = bn.indexOf(q) === 0 ? 0 : 1;
            if (aStarts !== bStarts) return aStarts - bStarts;
            return an.localeCompare(bn, "fr");
          }).slice(0, 8);

          if (!matches.length) {
            clientResults.innerHTML = '<div class="client-search-empty">Aucun client ne correspond à « ' + LM.escapeHtml(query) + ' ». Cliquez sur « Ajouter » pour en créer un nouveau.</div>';
            clientResults.style.display = "block";
            return;
          }

          clientResults.innerHTML = matches.map(function (c) {
            var addr = [c.adresse, c.codePostal, c.ville].filter(Boolean).join(" ");
            var already = selectedClients.some(function (sc) { return sc.clientId === c.id; });
            return '<div class="client-search-item' + (already ? " is-added" : "") + '" data-pick-client="' + c.id + '">' +
              '<div class="csi-name">' + LM.escapeHtml(c.nom) + (already ? ' <span class="csi-added-badge">Déjà ajouté</span>' : '') + '</div>' +
              '<div class="csi-meta">' +
                (addr ? '<span class="csi-meta-item">' + LM.icon("zones") + LM.escapeHtml(addr) + '</span>' : '<span class="csi-meta-item csi-meta-empty">' + LM.icon("zones") + 'Adresse non renseignée</span>') +
                (c.telephone ? '<span class="csi-meta-item">' + LM.icon("phone") + LM.escapeHtml(c.telephone) + '</span>' : '<span class="csi-meta-item csi-meta-empty">' + LM.icon("phone") + 'Téléphone non renseigné</span>') +
              '</div>' +
            '</div>';
          }).join("");
          clientResults.style.display = "block";

          clientResults.querySelectorAll("[data-pick-client]").forEach(function (item) {
            // "mousedown" (et non "click") pour s'exécuter avant le "blur" de l'input qui masque
            // la liste, sans quoi le clic sur un résultat ne serait jamais reçu.
            item.addEventListener("mousedown", function (e) {
              e.preventDefault();
              var id = item.getAttribute("data-pick-client");
              if (addSelectedClient(id)) {
                clientInput.value = "";
                hideClientResults();
              } else {
                renderClientResults(clientInput.value);
              }
            });
          });
        }

        clientInput.addEventListener("input", function () { renderClientResults(clientInput.value); });
        clientInput.addEventListener("focus", function () { if (clientInput.value.trim()) renderClientResults(clientInput.value); });
        clientInput.addEventListener("blur", function () { setTimeout(hideClientResults, 120); });
        clientInput.addEventListener("keydown", function (e) { if (e.key === "Escape") hideClientResults(); });

        modal.querySelector("#retAucunCb").addEventListener("change", function (e) {
          modal.querySelector("#retDetailsSection").style.display = e.target.checked ? "none" : "";
        });

        modal.querySelector("#cancelBtn").addEventListener("click", LM.closeModal);

        if (existing) {
          modal.querySelector("#deleteBtn").addEventListener("click", function () {
            LM.confirmDialog("Supprimer ce signalement de retard ?", function () {
              DB.removeRetard(livraisonRow.id);
              DB.logHistorique("Retards", "suppression", "Suppression signalement de retard : livraison du " + DB.fmtDate(livraisonRow.date) + " (" + (livraisonRow.livreurNom || "livreur inconnu") + ")");
              LM.toast("Signalement supprimé.", "success");
              LM.closeModal();
              if (typeof onSaved === "function") onSaved();
            });
          });
        }

        modal.querySelector("#btnAddRetClient").addEventListener("click", function () {
          var input = modal.querySelector("#retClientInput");
          var name = input.value.toString().trim();
          if (!name) return;
          var match = DB.resolveClientByName(name);
          if (match) {
            addSelectedClient(match.id);
            input.value = "";
            hideClientResults();
          } else {
            modal.querySelector("#ncNom").value = name;
            modal.querySelector("#ncContact").value = "";
            modal.querySelector("#ncTelephone").value = "";
            modal.querySelector("#ncAdresse").value = "";
            modal.querySelector("#ncVille").value = "";
            modal.querySelector("#retNewClientPanel").style.display = "block";
            hideClientResults();
          }
        });

        modal.querySelector("#btnCancelNewClient").addEventListener("click", function () {
          modal.querySelector("#retNewClientPanel").style.display = "none";
        });

        modal.querySelector("#btnCreateNewClient").addEventListener("click", function () {
          var nom = modal.querySelector("#ncNom").value.toString().trim();
          if (!nom) { LM.toast("Le nom du client est obligatoire.", "danger"); return; }
          var already = DB.resolveClientByName(nom);
          if (already) {
            addSelectedClient(already.id);
            LM.toast("Ce client existait déjà : ajouté à la liste.", "info");
          } else {
            var created = DB.add("clients", {
              nom: nom,
              contact: modal.querySelector("#ncContact").value.toString().trim(),
              telephone: modal.querySelector("#ncTelephone").value.toString().trim(),
              email: "",
              adresse: modal.querySelector("#ncAdresse").value.toString().trim(),
              codePostal: "",
              ville: modal.querySelector("#ncVille").value.toString().trim(),
              notes: ""
            });
            addSelectedClient(created.id);
            DB.logHistorique("Clients", "ajout", "Ajout client : " + nom);
            LM.toast("Client « " + nom + " » créé et ajouté.", "success");
          }
          modal.querySelector("#retClientInput").value = "";
          modal.querySelector("#retNewClientPanel").style.display = "none";
          hideClientResults();
          renderChips();
        });

        modal.querySelector("#saveBtn").addEventListener("click", function () {
          var fd = new FormData(modal.querySelector("#retForm"));
          var aucunRetard = modal.querySelector("#retAucunCb").checked;
          var n = 0;
          if (!aucunRetard) {
            n = Number(fd.get("nbLivraisonsRetard"));
            if (!isFinite(n) || n < 0) n = 0;
            var maxN = Number(livraisonRow.nbLivraisons) || 0;
            if (n > maxN) { LM.toast("Le nombre de retards ne peut pas dépasser le nombre de livraisons de cette entrée (" + maxN + ").", "danger"); return; }
          }
          var patch = {
            nbLivraisonsRetard: n,
            aucunRetard: aucunRetard,
            clients: aucunRetard ? [] : selectedClients.map(function (sc) {
              return { clientId: sc.clientId, tempsRetard: sc.tempsRetard, justifications: (sc.justifications || []).slice() };
            }),
            commentaire: (fd.get("commentaire") || "").toString().trim()
          };
          DB.upsertRetard(livraisonRow.id, patch);
          DB.logHistorique("Retards", existing ? "modification" : "ajout", (existing ? "Modification" : "Ajout") + " signalement de retard : livraison du " + DB.fmtDate(livraisonRow.date) + " (" + (livraisonRow.livreurNom || "livreur inconnu") + ") -> " + (aucunRetard ? "aucun retard" : (n + " en retard")));
          LM.toast("Retard enregistré.", "success");
          LM.closeModal();
          if (typeof onSaved === "function") onSaved();
        });

        function renderChips() {
          var wrap = modal.querySelector("#retClientChips");
          if (!selectedClients.length) {
            wrap.innerHTML = '<span class="text-faint text-sm">Aucun client sélectionné.</span>';
            return;
          }
          wrap.innerHTML = selectedClients.map(function (sc) {
            var nom = DB.clientNom(sc.clientId) || "Client supprimé";
            var justifs = Array.isArray(sc.justifications) ? sc.justifications : [];
            var motifOptions = DB.listeItems("motifsRetard").filter(function (m) { return justifs.indexOf(m.key) === -1; });
            var chipsHtml = justifs.length ? justifs.map(function (key) {
              var label = DB.listeLabel("motifsRetard", key) || "Justificatif supprimé";
              return '<span class="date-chip">' + LM.escapeHtml(label) + '<button type="button" data-rmmotif="' + sc.clientId + '|' + key + '">' + LM.icon("close") + '</button></span>';
            }).join("") : '<span class="text-faint text-sm">Aucun justificatif renseigné.</span>';
            return '<div class="card" style="background:var(--color-surface-alt);padding:12px;margin-bottom:10px;">' +
              '<div class="flex-between" style="margin-bottom:8px;">' +
                '<strong>' + LM.escapeHtml(nom) + '</strong>' +
                '<button type="button" class="btn btn-ghost btn-sm btn-icon" data-rmclient="' + sc.clientId + '" title="Retirer ce client">' + LM.icon("close") + '</button>' +
              '</div>' +
              '<div class="field mb-0" style="max-width:260px;margin-bottom:10px;">' +
                '<label>Temps de retard (minutes)</label>' +
                '<input type="number" min="0" data-temps="' + sc.clientId + '" value="' + (sc.tempsRetard != null ? sc.tempsRetard : "") + '" />' +
              '</div>' +
              '<div class="field mb-0">' +
                '<label>Justificatifs (3 maximum)</label>' +
                (justifs.length < 3 ?
                  '<div class="form-row" style="align-items:flex-end;margin-bottom:8px;">' +
                    '<div class="field mb-0" style="flex:2;"><select data-motif-select="' + sc.clientId + '">' +
                      '<option value="">Choisir un justificatif…</option>' +
                      motifOptions.map(function (m) { return '<option value="' + m.key + '">' + LM.escapeHtml(m.label) + '</option>'; }).join("") +
                    '</select></div>' +
                    '<div class="field mb-0"><button type="button" class="btn btn-secondary btn-sm" data-add-motif="' + sc.clientId + '">' + LM.icon("plus") + ' Ajouter</button></div>' +
                  '</div>'
                  : '<p class="text-sm text-faint" style="margin:0 0 8px;">Maximum de 3 justificatifs atteint.</p>') +
                '<div class="date-chip-list">' + chipsHtml + '</div>' +
              '</div>' +
            '</div>';
          }).join("");

          wrap.querySelectorAll("[data-rmclient]").forEach(function (btn) {
            btn.addEventListener("click", function () {
              var id = btn.getAttribute("data-rmclient");
              selectedClients = selectedClients.filter(function (sc) { return sc.clientId !== id; });
              renderChips();
            });
          });
          wrap.querySelectorAll("[data-temps]").forEach(function (input) {
            input.addEventListener("input", function () {
              var id = input.getAttribute("data-temps");
              var sc = selectedClients.filter(function (x) { return x.clientId === id; })[0];
              if (!sc) return;
              var v = Number(input.value);
              sc.tempsRetard = (input.value === "" || !isFinite(v) || v < 0) ? null : v;
            });
          });
          wrap.querySelectorAll("[data-add-motif]").forEach(function (btn) {
            btn.addEventListener("click", function () {
              var id = btn.getAttribute("data-add-motif");
              var select = wrap.querySelector('select[data-motif-select="' + id + '"]');
              var key = select ? select.value : "";
              if (!key) { LM.toast("Choisissez un justificatif dans la liste.", "info"); return; }
              var sc = selectedClients.filter(function (x) { return x.clientId === id; })[0];
              if (!sc) return;
              if (!Array.isArray(sc.justifications)) sc.justifications = [];
              if (sc.justifications.length >= 3) { LM.toast("Maximum de 3 justificatifs par client.", "danger"); return; }
              if (sc.justifications.indexOf(key) !== -1) { LM.toast("Ce justificatif est déjà sélectionné.", "info"); return; }
              sc.justifications.push(key);
              renderChips();
            });
          });
          wrap.querySelectorAll("[data-rmmotif]").forEach(function (btn) {
            btn.addEventListener("click", function () {
              var parts = btn.getAttribute("data-rmmotif").split("|");
              var id = parts[0], key = parts[1];
              var sc = selectedClients.filter(function (x) { return x.clientId === id; })[0];
              if (sc && Array.isArray(sc.justifications)) {
                sc.justifications = sc.justifications.filter(function (k) { return k !== key; });
              }
              renderChips();
            });
          });
        }

      }
    });
  }

  function kpiR(iconName, label, value) {
    return '<div class="kpi"><div class="kpi-label"><span class="kpi-icon">' + LM.icon(iconName) + '</span>' + label + '</div><div class="kpi-value">' + value + '</div></div>';
  }

  // Exposée via window.LMApp.openRetardForm pour être réutilisée par d'autres pages (ex :
  // Performance livreurs) sans dépendre du render() propre à cette page : l'appelant fournit son
  // propre callback onSaved plutôt que de coder en dur un rafraîchissement de la page Retards.
  window.LMApp = window.LMApp || {};
  window.LMApp.openRetardForm = openRetardForm;
})();


/* ==== js/historique.js ==== */
/*! historique.js - Journal d'activité : liste chronologique des actions effectuées dans
    l'application (ajouts, modifications, suppressions), alimentée par DB.logHistorique()
    depuis les autres pages. Filtrable, avec suppression ligne par ligne ou purge complète. */
(function () {
  "use strict";

  var PAGE_SIZE = 25;
  var searchQuery = "";
  var pageFilter = "";
  var actionFilter = "";
  var dateStart = "";
  var dateEnd = "";
  var histPage = 1;

  var ACTION_LABELS = { ajout: "Ajout", modification: "Modification", suppression: "Suppression" };
  var ACTION_CLS = { ajout: "badge-success", modification: "badge-info", suppression: "badge-danger" };

  App.registerPage("historique", {
    title: "Historique",
    subtitle: "Journal des actions effectuées dans l'application",
    render: render
  });

  function actionBadgeHtml(action) {
    var label = ACTION_LABELS[action] || action || "—";
    var cls = ACTION_CLS[action] || "badge-muted";
    return '<span class="badge ' + cls + '">' + LM.escapeHtml(label) + '</span>';
  }

  function fmtDateTime(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" }) +
      " à " + d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  }

  function allEntries() {
    return DB.list("historique").slice().sort(function (a, b) { return (b.ts || "").localeCompare(a.ts || ""); });
  }

  function render(content) {
    var all = allEntries();
    var todayIso = DB.todayISO();
    var weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    var weekAgoIso = weekAgo.toISOString();

    var countToday = all.filter(function (e) { return (e.ts || "").indexOf(todayIso) === 0; }).length;
    var countWeek = all.filter(function (e) { return (e.ts || "") >= weekAgoIso; }).length;

    var pageCounts = {};
    all.forEach(function (e) { pageCounts[e.page] = (pageCounts[e.page] || 0) + 1; });
    var pageNames = Object.keys(pageCounts).sort();
    var topPage = pageNames.slice().sort(function (a, b) { return pageCounts[b] - pageCounts[a]; })[0] || "—";

    content.innerHTML =
      '<div class="grid grid-4" style="margin-bottom:22px;">' +
        kpiH("historique", "Entrées enregistrées", DB.fmtNum(all.length)) +
        kpiH("clock", "Aujourd'hui", DB.fmtNum(countToday)) +
        kpiH("calendar", "7 derniers jours", DB.fmtNum(countWeek)) +
        kpiH("trend", "Page la plus active", LM.escapeHtml(topPage)) +
      '</div>' +
      '<div class="card">' +
        '<div class="card-header"><div><h2>Journal d\'activité</h2><p>Ajouts, modifications et suppressions effectués depuis les différentes pages de l\'application.</p></div>' +
          (all.length ? '<button class="btn btn-secondary" id="btnClearHisto">' + LM.icon("trash") + ' Vider l\'historique</button>' : '') +
        '</div>' +
        '<div class="form-row" style="flex-wrap:wrap;">' +
          '<div class="field" style="min-width:220px;flex:2;"><label>Recherche</label><input type="search" id="histSearch" placeholder="Rechercher dans les descriptions…" value="' + LM.escapeHtml(searchQuery) + '" /></div>' +
          '<div class="field"><label>Page</label><select id="histPageFilter"><option value="">Toutes les pages</option>' +
            pageNames.map(function (p) { return '<option value="' + LM.escapeHtml(p) + '"' + (p === pageFilter ? " selected" : "") + '>' + LM.escapeHtml(p) + ' (' + pageCounts[p] + ')</option>'; }).join("") +
          '</select></div>' +
          '<div class="field"><label>Action</label><select id="histActionFilter"><option value="">Toutes</option>' +
            Object.keys(ACTION_LABELS).map(function (k) { return '<option value="' + k + '"' + (k === actionFilter ? " selected" : "") + '>' + ACTION_LABELS[k] + '</option>'; }).join("") +
          '</select></div>' +
          '<div class="field"><label>Du</label><input type="date" id="histDateStart" value="' + dateStart + '" /></div>' +
          '<div class="field"><label>Au</label><input type="date" id="histDateEnd" value="' + dateEnd + '" /></div>' +
          '<div class="field" style="align-self:flex-end;"><button class="btn btn-ghost btn-sm" id="btnResetHistFilters">Réinitialiser</button></div>' +
        '</div>' +
        '<div class="table-wrap" style="margin-top:10px;"><table><thead><tr>' +
          '<th>Date &amp; heure</th><th>Page</th><th>Action</th><th>Description</th><th></th>' +
        '</tr></thead><tbody id="histBody"></tbody></table></div>' +
        '<div class="flex gap-10" style="margin-top:14px;align-items:center;justify-content:flex-end;">' +
          '<button class="btn btn-secondary btn-sm" id="prevHistPage">Précédent</button>' +
          '<span class="text-sm" id="histPageLabel"></span>' +
          '<button class="btn btn-secondary btn-sm" id="nextHistPage">Suivant</button>' +
        '</div>' +
      '</div>';

    renderRows();

    document.getElementById("histSearch").addEventListener("input", function (e) { searchQuery = e.target.value; histPage = 1; renderRows(); });
    document.getElementById("histPageFilter").addEventListener("change", function (e) { pageFilter = e.target.value; histPage = 1; renderRows(); });
    document.getElementById("histActionFilter").addEventListener("change", function (e) { actionFilter = e.target.value; histPage = 1; renderRows(); });
    document.getElementById("histDateStart").addEventListener("change", function (e) { dateStart = e.target.value; histPage = 1; renderRows(); });
    document.getElementById("histDateEnd").addEventListener("change", function (e) { dateEnd = e.target.value; histPage = 1; renderRows(); });
    document.getElementById("btnResetHistFilters").addEventListener("click", function () {
      searchQuery = ""; pageFilter = ""; actionFilter = ""; dateStart = ""; dateEnd = ""; histPage = 1;
      render(content);
    });
    var clearBtn = document.getElementById("btnClearHisto");
    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        LM.confirmDialog("Vider tout l'historique ? Cette action est irréversible.", function () {
          var data = DB.getData();
          var count = (data.historique || []).length;
          data.historique = [];
          DB.save();
          DB.logHistorique("Historique", "suppression", "Purge de l'historique (" + count + " entrée(s) supprimée(s))");
          render(content);
        });
      });
    }

    function renderRows() {
      var q = DB.normalizeStr(searchQuery);
      var filtered = all.filter(function (e) {
        if (pageFilter && e.page !== pageFilter) return false;
        if (actionFilter && e.action !== actionFilter) return false;
        var day = (e.ts || "").slice(0, 10);
        if (dateStart && day < dateStart) return false;
        if (dateEnd && day > dateEnd) return false;
        if (q) {
          var hay = DB.normalizeStr([e.page, e.description].filter(Boolean).join(" "));
          if (hay.indexOf(q) === -1) return false;
        }
        return true;
      });

      var tbody = document.getElementById("histBody");
      if (!filtered.length) {
        tbody.innerHTML = '<tr class="empty-row"><td colspan="5">Aucune entrée ne correspond à ces critères.</td></tr>';
        document.getElementById("histPageLabel").textContent = "";
        document.getElementById("prevHistPage").disabled = true;
        document.getElementById("nextHistPage").disabled = true;
        return;
      }

      var totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
      if (histPage > totalPages) histPage = totalPages;
      if (histPage < 1) histPage = 1;
      var pageRows = filtered.slice((histPage - 1) * PAGE_SIZE, histPage * PAGE_SIZE);

      tbody.innerHTML = pageRows.map(function (e) {
        return '<tr>' +
          '<td class="text-sm text-faint" style="white-space:nowrap;">' + fmtDateTime(e.ts) + '</td>' +
          '<td><span class="chip">' + LM.escapeHtml(e.page || "—") + '</span></td>' +
          '<td>' + actionBadgeHtml(e.action) + '</td>' +
          '<td class="text-sm">' + LM.escapeHtml(e.description || "") + '</td>' +
          '<td class="actions"><button class="btn btn-ghost btn-sm btn-icon" data-delhist="' + e.id + '" title="Supprimer cette entrée">' + LM.icon("trash") + '</button></td>' +
        '</tr>';
      }).join("");

      document.getElementById("histPageLabel").textContent = "Page " + histPage + " / " + totalPages + " — " + filtered.length + " entrée(s)";
      document.getElementById("prevHistPage").disabled = histPage <= 1;
      document.getElementById("nextHistPage").disabled = histPage >= totalPages;

      tbody.querySelectorAll("[data-delhist]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var id = btn.getAttribute("data-delhist");
          LM.confirmDialog("Supprimer cette entrée de l'historique ?", function () {
            DB.remove("historique", id);
            all = allEntries();
            renderRows();
          });
        });
      });
    }

    document.getElementById("prevHistPage").addEventListener("click", function () { if (histPage > 1) { histPage--; renderRows(); } });
    document.getElementById("nextHistPage").addEventListener("click", function () { histPage++; renderRows(); });
  }

  function kpiH(iconName, label, value) {
    return '<div class="kpi"><div class="kpi-label"><span class="kpi-icon">' + LM.icon(iconName) + '</span>' + label + '</div><div class="kpi-value">' + value + '</div></div>';
  }
})();
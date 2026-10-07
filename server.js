require('dotenv').config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
console.log(process.env.STRIPE_SECRET_KEY);
const express = require('express');
const app = express();
const fs = require('fs');
const cors = require('cors'); // Gère les requêtes cross-origin entre le front et le back

// Grille tarifaire sécurisée stockée côté serveur
const GRILLE_TARIFAIRE = {
    'panier_unique': { nom: 'Le panier Découverte', prix: 40 },
    'formule_5': { nom: 'Votre Carnet de 5 Paniers Bio', prix: 190 },
    'formule_10': { nom: 'Votre Carnet de 10 Paniers Bio', prix: 360 },
    'abo_trimestriel': { nom: 'Club Bio - Formule Petite Saison', prix: 210 },
    'abo_semestriel': { nom: 'Club Bio - Formule Grande Saison', prix: 420 },
    'aucun': { nom: 'Produits sur-mesure uniquement', prix: 0 }
};

const PRIX_PRODUITS_SUR_MESURE = {
    'Tomates anciennes': 7.50,
    'Pomme de terre': 4.95,
    'Courgettes du jardin': 5.50,
    'Radis croquants': 4.00,
    'Citrons bio': 2.50,
    'Betteraves fraîches': 3.80,
    'Haricots verts': 6.50,
    'Bananes': 3.00,
    'Tomate Cerise': 3.00,
    'Brèdes': 2.00,
    'Salade': 2.00,
    'Roquette': 2.50
};

// Activation de CORS pour autoriser les communications locales
app.use(cors());

// Middleware pour récupérer le corps brut (raw body) indispensable à la validation du webhook Stripe,
// tout en appliquant express.json() pour les autres routes normales.
app.use((req, res, next) => {
    if (req.originalUrl === '/webhook') {
        let data = '';
        req.setEncoding('utf8');
        req.on('data', chunk => {
            data += chunk;
        });
        req.on('end', () => {
            req.rawBody = data;
            next();
        });
    } else {
        express.json()(req, res, next);
    }
});

// MODIFICATION : Utilisation de __dirname pour servir les fichiers statiques depuis la racine du projet
app.use(express.static(__dirname));

// Route pour fournir la clé publique Stripe au front-end
app.get('/config', (req, res) => {
    res.send({
        publicKey: process.env.STRIPE_PUBLISHABLE_KEY
    });
});

// Route pour créer la session de paiement Stripe
app.post('/create-checkout-session', async (req, res) => {
    try {
        const { 
            formule, 
            produitsSurMesure, 
            nom, 
            prenom, 
            adresse, 
            telephone, 
            date_livraison, 
            message 
        } = req.body;

        // Tableau dynamique qui contiendra les éléments détaillés pour Stripe
        let lineItems = [];

        // 1. Validation et ajout de la formule principale dans les line_items
        let montantFormule = 0;

        if (formule && GRILLE_TARIFAIRE[formule]) {
            montantFormule = GRILLE_TARIFAIRE[formule].prix;
            const nomFormule = GRILLE_TARIFAIRE[formule].nom;

            if (montantFormule > 0) {
                lineItems.push({
                    price_data: {
                        currency: 'eur',
                        product_data: {
                            name: nomFormule,
                        },
                        unit_amount: Math.round(montantFormule * 100),
                    },
                    quantity: 1,
                });
            }
        } else if (formule && formule !== 'aucun') {
            return res.status(400).json({ error: "Formule invalide." });
        }

        // 2. Validation et ajout sécurisé de chaque produit sur-mesure dans les line_items
        let montantSurMesure = 0;
        let produitsValides = [];

        if (Array.isArray(produitsSurMesure)) {
            for (let item of produitsSurMesure) {
                const nomProduit = item.nom;
                const quantite = parseFloat(item.quantite);

                if (nomProduit && PRIX_PRODUITS_SUR_MESURE[nomProduit] !== undefined && !isNaN(quantite) && quantite > 0) {
                    const prixUnitaire = PRIX_PRODUITS_SUR_MESURE[nomProduit];
                    const totalLigne = quantite * prixUnitaire;
                    montantSurMesure += totalLigne;

                    produitsValides.push({
                        nom: nomProduit,
                        quantite: quantite,
                        prixUnitaireEuros: prixUnitaire,
                        totalLigneEuros: totalLigne
                    });

                    // Ajout de chaque produit sur-mesure en tant que ligne distincte sur Stripe
                    lineItems.push({
                        price_data: {
                            currency: 'eur',
                            product_data: {
                                name: `${nomProduit} (Sur-mesure)`,
                            },
                            unit_amount: Math.round(prixUnitaire * 100),
                        },
                        quantity: quantite,
                    });
                }
            }
        }

        // 3. Application sécurisée et explicite des frais de livraison (10€ si uniquement du sur-mesure ou pas de formule principale)
        let fraisLivraison = ((!formule || formule === 'aucun') && montantSurMesure > 0) ? 10 : 0;

        if (fraisLivraison > 0) {
            lineItems.push({
                price_data: {
                    currency: 'eur',
                    product_data: {
                        name: 'Frais de livraison',
                    },
                    unit_amount: Math.round(fraisLivraison * 100),
                },
                quantity: 1,
            });
        }

        // 4. Calcul du montant total final en euros et centimes
        let montantTotalEuros = montantFormule + montantSurMesure + fraisLivraison;

        if (montantTotalEuros <= 0 || lineItems.length === 0) {
            return res.status(400).json({ error: "Le montant total de la commande doit être supérieur à 0." });
        }

        // Stockage des informations dans les métadonnées de Stripe (limité à 500 caractères par valeur)
        const produitsSurMesureString = JSON.stringify(produitsValides);
        
        const metadataPayload = {
            formule: formule || '',
            nom: nom || '',
            prenom: prenom || '',
            adresse: adresse || '',
            telephone: telephone || '',
            date_livraison: date_livraison || '',
            message: message || '',
            fraisLivraison: fraisLivraison.toString(),
            montantTotalEuros: montantTotalEuros.toString(),
            produitsSurMesure_1: produitsSurMesureString.substring(0, 500),
            produitsSurMesure_2: produitsSurMesureString.substring(500, 1000) || '',
            produitsSurMesure_3: produitsSurMesureString.substring(1000, 1500) || ''
        };

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: lineItems,
            mode: 'payment',
            metadata: metadataPayload,
            success_url: `${req.protocol}://${req.get('host')}/success.html?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${req.protocol}://${req.get('host')}/cancel.html`,
        });

        res.status(200).send({
            id: session.id,
            url: session.url
        });

    } catch (error) {
        console.error("Erreur Stripe détaillée :", error);
        res.status(500).send({ error: error.message });
    }
});

// Route /webhook pour écouter l'événement de paiement validé par Stripe
app.post('/webhook', async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error(`Erreur de signature Webhook : ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
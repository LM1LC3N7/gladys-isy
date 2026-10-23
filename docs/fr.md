# ISY / IoX (Universal Devices) pour Gladys Assistant

Cette intégration relie Gladys à un **contrôleur Universal Devices** de votre
réseau local : un **ISY994**, ou **IoX** sur un **eisy** ou un **Polisy**.
Elle lit les nœuds Insteon et Z-Wave du contrôleur, ses variables et une
partie de ses programmes, suit leurs changements en direct, et pilote les
lumières et interrupteurs Insteon que vous déclarez sûrs.

> Intégration non officielle, sans lien avec Universal Devices.
>
> **Jamais testée avec un vrai appareil** : elle a été écrite à partir de la
> bibliothèque PyISY (celle de Home Assistant) et testée uniquement contre un
> contrôleur simulé. Vos retours sont les bienvenus.

## Ce que vous obtenez

| Nœud du contrôleur                                               | Dans Gladys                                                                                                                            |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Variateur Insteon déclaré sûr                                    | une lumière : allumage et luminosité                                                                                                   |
| Interrupteur (relais) Insteon déclaré sûr                        | un interrupteur (ou une lumière)                                                                                                       |
| Variateur ou interrupteur Insteon **non** déclaré sûr            | son état (et son niveau), en lecture seule, et des boutons « Allumer » / « Éteindre », désactivés par défaut                           |
| Serrure (Insteon, Z-Wave)                                        | « Verrouillé », en lecture seule, et sa batterie                                                                                       |
| Thermostat (Insteon, Z-Wave)                                     | sa température et son humidité, en lecture seule                                                                                       |
| Tout autre nœud (capteurs, boutons de clavier, Z-Wave, I/O Linc) | son état (ou son niveau), en lecture seule, et ce qu'il mesure : température, humidité, lumière, puissance, tension, courant, batterie |
| Variables entières et d'état                                     | leur valeur, en lecture seule                                                                                                          |
| Programmes d'un dossier nommé **Gladys**                         | un bouton « Lancer », désactivé par défaut, et le résultat de leur dernière condition                                                  |
| Interrupteurs, boutons de clavier, télécommandes pressés         | le déclencheur de scène « Événement de commande ISY »                                                                                  |

Pas encore pris en charge : le HTTPS, les commandes des variateurs et
interrupteurs Z-Wave, des serrures, des thermostats et des portes de garage
(I/O Linc), les scènes (groupes) du contrôleur, l'écriture des variables, les
commandes des node servers, les totaux d'énergie (kWh).

## Mise en place

1. Donnez au contrôleur une adresse IP fixe dans votre box.
2. Dans Gladys, ouvrez l'intégration et saisissez :
   - l'**adresse du contrôleur** (son adresse IP) et son **port HTTP** :
     8080 sur un eisy ou un Polisy, 80 sur un ISY994 ;
   - le **nom d'utilisateur** et le **mot de passe** de l'ISY Admin Console.
     Le mot de passe est gardé par Gladys dans sa base, jamais réaffiché,
     envoyé seulement au contrôleur, jamais écrit dans les journaux. HTTP
     seulement pour l'instant : tout appareil qui lit votre réseau local peut
     le lire ;
   - facultativement l'**identifiant du contrôleur** (son UUID, dans l'ISY
     Admin Console sous Help > About). Laissé vide, le contrôleur trouvé à la
     première connexion est retenu.
3. Enregistrez, puis cliquez sur **Tester la connexion**.
4. Ajoutez les appareils depuis l'onglet **Découverte**.

## Lumières et interrupteurs : déclarez-les sûrs

Une lumière ou un interrupteur dans Gladys obéit à Google Home, Alexa, au MCP
(« éteins tout ») et à toutes les scènes. Un interrupteur ou un variateur
Insteon peut commander n'importe quoi : une lampe, mais aussi une pompe, un
chauffage, un congélateur, une porte de garage. Un variateur ou un
interrupteur n'est donc une lumière ou un interrupteur **que si vous listez
son adresse dans « Nœuds déclarés sûrs »**, telle que l'ISY Admin Console
l'affiche, par exemple :

```
1A 2B 3C 1, 4D 5E 6F 1: light
```

Un variateur est toujours une lumière ; un interrupteur est un interrupteur,
ou une lumière s'il est suivi de `: light`. Les autres montrent leur état, et
deux boutons « Allumer » et « Éteindre » qui ne fonctionnent qu'une fois
**« Autoriser les boutons Allumer / Éteindre »** cochée. Si vous déclarez un
nœud sûr plus tard, ses nouvelles fonctionnalités apparaissent dans la
Découverte ; supprimez les anciennes dont vous ne voulez plus (leur historique
part avec elles).

## Programmes

Placez les programmes que Gladys peut lancer dans un dossier nommé
**Gladys** de l'ISY Admin Console (directement dedans, pas dans un
sous-dossier). Chacun reçoit un bouton **Lancer** (le contrôleur évalue son
If, puis exécute son Then ou son Else) et le résultat de sa dernière
condition. Les boutons ne fonctionnent qu'une fois **« Autoriser le lancement
des programmes du dossier Gladys »** cochée : un programme peut tout faire,
déverrouiller une porte ou ouvrir un garage. Un programme sorti du dossier ne
peut plus être lancé.

## Commandes

Une commande part dans les 3,5 secondes ou pas du tout (« rien n'a été
envoyé »). Elle n'est confirmée que lorsque le contrôleur signale le niveau
demandé ; sinon Gladys affiche « envoyé, sans confirmation » et le nœud est
relu 2 secondes plus tard. Le lancement d'un programme est confirmé par la
réponse du contrôleur, qui l'exécute lui-même. Chaque commande est écrite
dans les journaux de l'intégration.

## Déclencheur de scène « Événement de commande ISY »

Chaque événement de commande d'un nœud (un interrupteur, un bouton de clavier
ou une télécommande pressé) déclenche la scène avec :

- `address` : l'adresse du nœud, telle que l'ISY Admin Console l'affiche
  (`1A 2B 3C 1`) : elle est comparée telle quelle ;
- `control` : `DON` (allumé), `DOF` (éteint), `DFON` / `DFOF` (double
  appui), `FDUP` / `FDDOWN` (maintien), `FDSTOP` (relâché), `BRT`, `DIM` ;
- `name` : le nom du nœud.

La relecture de tous les états à l'ouverture du flux d'événements ne le
déclenche jamais. 120 événements par minute au plus.

## Lectures et limites

- Le contrôleur envoie chaque changement au fil de l'eau. À chaque intervalle
  de **lecture des états** (10 minutes par défaut), tous les états sont relus.
  Un redémarrage de l'intégration ne relit jamais plus tôt.
- La liste des nœuds, variables et programmes est lue à la première
  connexion, puis à nouveau sur **Scanner** dans la Découverte ou quand le
  contrôleur signale un changement de ses nœuds, au plus toutes les 10
  minutes.
- **Un autre contrôleur** répond à la même adresse IP (après un changement de
  box) : rien n'est lu ni envoyé tant que vous ne saisissez pas son
  identifiant.
- **Mot de passe refusé** : l'intégration s'arrête et ne réessaie jamais
  d'elle-même. Corrigez le mot de passe, ou cliquez sur « Tester la
  connexion » quand le contrôleur l'accepte.
- **Contrôleur injoignable** : nouveaux essais après 10 s, 30 s, 1, 2, puis
  toutes les 5 minutes ; la pause est gardée après un redémarrage.
- Unités : celles du contrôleur, figées à la création de la fonctionnalité
  (une température en °F reste en °F).

## Crédits

L'API REST et le flux d'événements du contrôleur viennent de
[PyISY](https://github.com/automicus/PyISY) (Apache 2.0, Automicus), voir
`THIRD_PARTY_NOTICES.md`.

/**
 * Événements de streaming, communs aux deux protocoles.
 *
 * Un flux rend la même séquence quel que soit le fournisseur : `text`* puis
 * éventuellement `tool_call`*, et toujours un `done` final qui porte la
 * `Response` complète (usage, coût, `finishReason`). Boucler sur les deltas OU
 * attendre le `done` sont donc deux façons valables de consommer.
 *
 * `TextStream` ajoute la commodité qui compte à l'usage :
 *
 *     for await (const morceau of stream("Raconte")) process.stdout.write(morceau);
 *     const total = await stream("Raconte").response;
 */
/**
 * Enveloppe un flux d'événements en `TextStream`.
 *
 * La source est consommée AVIDEMENT, dans une tâche de fond, et les événements
 * sont tamponnés. C'est ce qui fait marcher les deux usages naturels :
 *
 *   - `await stream(…).response` seul — sans avidité, la promesse n'aurait
 *     jamais été résolue puisque personne ne tire le générateur ;
 *   - `for await (… of stream(…))` puis `await .response`.
 *
 * Le tampon permet aussi à plusieurs consommateurs (texte ET `events`) de tout
 * voir. Perdre la contre-pression est sans conséquence ici : un flux de réponse
 * LLM tient dans quelques kilo-octets.
 */
export function toTextStream(source) {
    const tampon = [];
    const attentes = [];
    let termine = false;
    let echec;
    let resoudre;
    let rejeter;
    const promesse = new Promise((ok, ko) => {
        resoudre = ok;
        rejeter = ko;
    });
    // Sans ce `catch`, un flux en erreur consommé uniquement par `for await`
    // ferait un rejet non géré sur `response`, que Node signale bruyamment.
    promesse.catch(() => undefined);
    const reveiller = () => {
        for (const reveil of attentes.splice(0))
            reveil();
    };
    void (async () => {
        let vuDone = false;
        try {
            for await (const evenement of source) {
                tampon.push(evenement);
                if (evenement.type === "done") {
                    vuDone = true;
                    resoudre(evenement.response);
                }
                reveiller();
            }
            if (!vuDone)
                rejeter(new Error("flux terminé sans réponse finale"));
        }
        catch (err) {
            echec = err;
            rejeter(err);
        }
        finally {
            termine = true;
            reveiller();
        }
    })();
    async function* drainer() {
        let i = 0;
        for (;;) {
            while (i < tampon.length)
                yield tampon[i++];
            if (termine) {
                if (echec)
                    throw echec;
                return;
            }
            await new Promise((r) => attentes.push(r));
        }
    }
    return {
        async *[Symbol.asyncIterator]() {
            for await (const evenement of drainer()) {
                if (evenement.type === "text")
                    yield evenement.text;
            }
        },
        get response() {
            return promesse;
        },
        get events() {
            return { [Symbol.asyncIterator]: drainer };
        },
    };
}

# providall (Python)

Package Python de [providall](../README.md) : un appel LLM, n'importe quel
fournisseur. Le README complet, la table des variables d'environnement et le
registre des modèles sont à la racine du dépôt.

```bash
uv add "git+ssh://git@github.com/EpsilonFO/providall.git" --tag v0.1.0 --subdirectory python
```

```python
import providall

print(providall.complete("Dis bonjour").text)
```

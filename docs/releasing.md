# Releasing the AI Tools Pi package

A release is an annotated Git tag `vX.Y.Z` for the entire repository. Individual extensions are selectable resources, not release targets. No npm publishing, release tarballs, or additional package metadata are needed.

1. Update the root [changelog](../CHANGELOG.md) with the release version and date. Describe any changes to extension paths, commands, or compatibility.
2. Run `make check` with the [test host configured](../README.md#develop-and-test). Confirm the release commit is on `main` and CI has passed for it.
3. Create a new annotated tag for that exact commit: `git tag -a vX.Y.Z <commit> -m 'AI Tools for Pi vX.Y.Z'`. Never reuse or move an existing tag. `v0.1.0` belongs to the historical aggregate package.
4. Publish the tag only after approval. Include the changelog notes and the pinned install source (`pi install git:github.com/debonzi/ai-tools@vX.Y.Z`) in the release announcement.

Users on a branch source can update with `pi update git:github.com/debonzi/ai-tools`. Users with a pinned source must select a new ref explicitly. To roll back, select the previous known-good ref; leave both tags intact.

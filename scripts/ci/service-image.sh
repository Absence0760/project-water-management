#!/usr/bin/env bash
# A docker-compose.yml service's image, pulled once and handed between CI
# jobs as a tarball, so the jobs that run it don't each pull it from its
# registry: Docker Hub's anonymous pull limit refused CI's runners (issue
# #492), and so did ECR Public's ("toomanyrequests: Data limit exceeded")
# once every DB job and e2e shard pulled Postgres from it (issue #521).
#
#   save <service> <tar>  pull the image by docker-compose.yml's pinned
#                         tag@digest, check the digest, write it to <tar>
#   load <service> <tar>  load <tar>, check it is that digest, and write
#                         $RUNNER_TEMP/compose.<service>.yml, an override
#                         that starts the service from the loaded image
#                         and never pulls
#
# A loaded image has no repo digest to match a tag@digest reference (docker
# save/load drops it), so the override names the tag alone with
# `pull_policy: never`; the image is checked here instead, by its layers'
# content digests (RootFS.Layers, the diff IDs), against the ones save
# recorded beside the tarball. Not by `.Id`: with the containerd image store
# (Docker 29's default, on CI's runners from 2026-11) a pulled image's ID is
# its index or manifest digest while a loaded one's is another, so IDs never
# matched across save and load (every DB job and e2e shard failed, PR #785).
# The diff IDs are the same under both stores, before and after save/load.
set -euo pipefail

cmd=${1:?save or load}
service=${2:?service}
tar=${3:?tarball}

ref=$(docker compose config --images "$service")
case "$ref" in
	*@sha256:*) ;;
	*) echo "service-image: $service's image ($ref) isn't pinned by digest" >&2; exit 1 ;;
esac
name_tag=${ref%@*}
digest=${ref#*@}
name=${name_tag%:*}

# The image's filesystem layers' content digests, as one line (stable across image stores and save/load).
layers() { docker image inspect --format '{{json .RootFS.Layers}}' "$1"; }

case "$cmd" in
	save)
		mkdir -p "$(dirname "$tar")"
		# By digest, so whichever registry answers serves the same bytes.
		# A Docker Hub image, or ECR Public's copy of a Docker official one
		# (docker/library, the same digest): Google's Docker Hub mirror first,
		# the image's own registry only if the mirror hasn't cached it (issue
		# #492). Any other registry's image (GHCR's Mailpit): its own registry.
		case "$name" in
			public.ecr.aws/docker/library/*) mirror="mirror.gcr.io/library/${name#public.ecr.aws/docker/library/}" ;;
			*.*/*) mirror="" ;;
			*/*) mirror="mirror.gcr.io/$name" ;;
			*) mirror="mirror.gcr.io/library/$name" ;;
		esac
		src="$name@$digest"
		if [ -n "$mirror" ] && docker pull "$mirror@$digest"; then src="$mirror@$digest"; else docker pull "$src"; fi
		docker tag "$src" "$name_tag"
		docker save -o "$tar" "$name_tag"
		layers "$name_tag" > "$tar.layers"
		;;
	load)
		docker load -i "$tar"
		# Its layers are the ones save pulled by the pin.
		want=$(cat "$tar.layers" 2>/dev/null || true)
		if [ -z "$want" ]; then
			echo "service-image: $tar.layers is missing, so the loaded image can't be checked against $digest" >&2
			exit 1
		fi
		got=$(layers "$name_tag")
		if [ "$got" != "$want" ]; then
			echo "service-image: loaded $name_tag has layers $got, not the $want saved from $digest" >&2
			exit 1
		fi
		printf 'services:\n  %s:\n    image: %s\n    pull_policy: never\n' "$service" "$name_tag" > "$RUNNER_TEMP/compose.$service.yml"
		;;
	*)
		echo "service-image: unknown command $cmd (save or load)" >&2
		exit 1
		;;
esac

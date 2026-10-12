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
# `pull_policy: never`; the digest is checked here instead, by the image's
# config, against the one save recorded beside the tarball.
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
		docker image inspect --format '{{.Id}}' "$name_tag" > "$tar.id"
		;;
	load)
		docker load -i "$tar"
		# The image's ID (its config's digest) is the one save pulled by the pin.
		want=$(cat "$tar.id" 2>/dev/null || true)
		got=$(docker image inspect --format '{{.Id}}' "$name_tag")
		if [ -n "$want" ] && [ "$got" != "$want" ]; then
			echo "service-image: loaded $name_tag is $got, not the $want saved from $digest" >&2
			exit 1
		fi
		printf 'services:\n  %s:\n    image: %s\n    pull_policy: never\n' "$service" "$name_tag" > "$RUNNER_TEMP/compose.$service.yml"
		;;
	*)
		echo "service-image: unknown command $cmd (save or load)" >&2
		exit 1
		;;
esac

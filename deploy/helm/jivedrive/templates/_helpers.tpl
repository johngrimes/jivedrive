{{/*
Standard labels applied to every JiveDrive resource.
*/}}
{{- define "jivedrive.labels" -}}
app.kubernetes.io/name: jivedrive
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

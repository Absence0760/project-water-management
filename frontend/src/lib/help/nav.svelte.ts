// Where the reader is in the glossary: the glossary page's scroll spy writes
// it, and the help sidebar (in the /help layout) reads it to mark the topic
// and term being read.
export const glossaryPosition = $state({ topic: '', entry: '' });

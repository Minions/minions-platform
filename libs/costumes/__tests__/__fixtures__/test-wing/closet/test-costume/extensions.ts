/**
 * Test costume extensions — one action group on the henchery endpoint.
 */
export function getExtensions() {
  return {
    actionGroups: [
      {
        def: {
          name: 'test_extension_group',
          description: 'A test action group exposed via CostumeExtensions',
          coreActions: {
            ping: {
              description: 'Ping',
              help: 'Pings.',
              async execute() {
                return { pong: true };
              },
            },
          },
        },
        endpoints: ['henchery'],
      },
    ],
  };
}

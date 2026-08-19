import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import WingDetail from './WingDetail.vue';

describe('WingDetail', () => {
  const mockDistrict = {
    name: 'central-planning',
    root: '/wings/central-planning',
    workLocal: '/wings/central-planning/work/local',
    workGlobal: '/wings/central-planning/work/global',
    privateLocal: '/wings/central-planning/private/local',
    privateGlobal: '/wings/central-planning/private/global',
    info: '/wings/central-planning/info'
  };

  it('displays wing name', () => {
    const wrapper = mount(WingDetail, {
      props: { wing: mockDistrict }
    });

    expect(wrapper.text()).toContain('central-planning');
  });

  it('displays work paths', () => {
    const wrapper = mount(WingDetail, {
      props: { wing: mockDistrict }
    });

    expect(wrapper.text()).toContain('work/local');
    expect(wrapper.text()).toContain('work/global');
  });

  it('displays private paths', () => {
    const wrapper = mount(WingDetail, {
      props: { wing: mockDistrict }
    });

    expect(wrapper.text()).toContain('private/local');
    expect(wrapper.text()).toContain('private/global');
  });

  it('displays info path', () => {
    const wrapper = mount(WingDetail, {
      props: { wing: mockDistrict }
    });

    expect(wrapper.text()).toContain('info');
  });
});

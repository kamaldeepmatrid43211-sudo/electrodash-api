import { describe, expect, it } from 'vitest';

import { cardTags } from '../src/routes/catalog.js';

const spec = (label: string, value: string) => ({ label, value });

describe('card tag chips', () => {
  it('picks short, useful values with wattage and colour first', () => {
    expect(
      cardTags([
        spec('Shape', 'Round'),
        spec('Light Color', 'Natural white'),
        spec('Wattage', '10W'),
        spec('Country of Origin', 'India'),
      ]),
    ).toEqual(['10W', 'Natural white']);
  });

  it('skips long values, values with brackets and unhelpful labels', () => {
    expect(
      cardTags([
        spec('Wattage', '3 × 6W G9 LED bulbs (included)'),
        spec('Color Temperature', '2700K (Warm White)'),
        spec('Warranty', '2 years'),
        spec('Dimensions', '141 x 112 mm'),
        spec('Body Color', 'Black'),
      ]),
    ).toEqual(['Black']);
  });

  it('never repeats a value and returns nothing when there is nothing short', () => {
    expect(cardTags([spec('Body Color', 'White'), spec('Light Color', 'White')])).toEqual(['White']);
    expect(cardTags([spec('Material', 'Clear acrylic, milky white ceramics')]).length).toBe(0);
  });
});

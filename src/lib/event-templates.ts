/** Starting text for common notices. Khmer is written first; authors edit before publishing. */
export type EventTemplate = {
  key: string;
  type: 'event' | 'holiday' | 'announcement';
  nameKm: string;
  nameEn: string;
  titleKm: string;
  titleEn: string;
  bodyKm: string;
  bodyEn: string;
  celebrate?: boolean;
};

export const EVENT_TEMPLATES: EventTemplate[] = [
  {
    key: 'khmer_new_year', type: 'holiday', celebrate: true,
    nameKm: 'បុណ្យចូលឆ្នាំខ្មែរ', nameEn: 'Khmer New Year',
    titleKm: 'សួស្តីឆ្នាំថ្មី', titleEn: 'Happy Khmer New Year',
    bodyKm: 'សូមជូនពរបុគ្គលិកទាំងអស់ និងក្រុមគ្រួសារ ជួបតែសេចក្តីសុខ សុភមង្គល និងសុខភាពល្អ ក្នុងឱកាសបុណ្យចូលឆ្នាំថ្មីប្រពៃណីខ្មែរ។',
    bodyEn: 'Wishing all staff and their families happiness and good health for the Khmer New Year.',
  },
  {
    key: 'pchum_ben', type: 'holiday',
    nameKm: 'បុណ្យភ្ជុំបិណ្ឌ', nameEn: 'Pchum Ben',
    titleKm: 'បុណ្យភ្ជុំបិណ្ឌ', titleEn: 'Pchum Ben',
    bodyKm: 'សូមជូនពរបុគ្គលិកទាំងអស់ធ្វើដំណើរទៅស្រុកកំណើតប្រកបដោយសុវត្ថិភាព ក្នុងឱកាសបុណ្យភ្ជុំបិណ្ឌ។',
    bodyEn: 'Wishing all staff safe travels home for Pchum Ben.',
  },
  {
    key: 'water_festival', type: 'holiday', celebrate: true,
    nameKm: 'បុណ្យអុំទូក', nameEn: 'Water Festival',
    titleKm: 'ព្រះរាជពិធីបុណ្យអុំទូក', titleEn: 'Water Festival',
    bodyKm: 'សូមជូនពរបុគ្គលិកទាំងអស់សប្បាយរីករាយក្នុងឱកាសបុណ្យអុំទូក បណ្តែតប្រទីប និងសំពះព្រះខែ អកអំបុក។',
    bodyEn: 'Wishing all staff a joyful Water Festival.',
  },
  {
    key: 'staff_meeting', type: 'event',
    nameKm: 'ប្រជុំបុគ្គលិក', nameEn: 'Staff meeting',
    titleKm: 'ប្រជុំបុគ្គលិក', titleEn: 'Staff meeting',
    bodyKm: 'សូមអញ្ជើញបុគ្គលិកទាំងអស់ចូលរួមប្រជុំ។ ម៉ោង៖ … ទីកន្លែង៖ …',
    bodyEn: 'All staff are invited to a meeting. Time: … Place: …',
  },
  {
    key: 'notice', type: 'announcement',
    nameKm: 'សេចក្តីជូនដំណឹងទូទៅ', nameEn: 'General notice',
    titleKm: 'សេចក្តីជូនដំណឹង', titleEn: 'Notice',
    bodyKm: '', bodyEn: '',
  },
];
